/*
 * Copyright 2021 Jason Shobe
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { ECRClient, GetAuthorizationTokenCommand } = require('@aws-sdk/client-ecr');
const k8s = require('@kubernetes/client-node');
const cron = require('node-cron');
const differenceInMinutes = require('date-fns/differenceInMinutes');
const formatISO = require('date-fns/formatISO');

const registry = process.env.DOCKER_REGISTRY;
const secretName = process.env.ECR_SECRET_NAME;
const labelSelector = `${process.env.ECR_LABEL_NAME}=${process.env.ECR_LABEL_VALUE}`;
const cronSchedule = process.env.ECR_CRON_SCHEDULE;

const k8sConfig = new k8s.KubeConfig();
k8sConfig.loadFromDefault();
const k8sOptions = {};
k8sConfig.applyToRequest(k8sOptions);
const k8sApi = k8sConfig.makeApiClient(k8s.CoreV1Api);

var cachedToken = undefined;

/**
 * Checks the status of an HTTP response and throws an error if necessary.
 * 
 * @param {object} response the HTTP response object.
 * @param {function} messageSupplier a function that supplies the error message.
 */
function checkStatus(response, messageSupplier) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(messageSupplier());
    }
}

function logInfo(message) {
    const timestamp = formatISO(new Date())
    console.log(`${timestamp} INFO  ${message}`)
}

/**
 * Writes an error message to the log.
 * 
 * @param {string} message the error message.
 * @param {*} error the error object.
 */
function logError(message, error) {
    const timestamp = formatISO(new Date())
    var logMessage;

    if(error.stack) {
        logMessage = `${message}: ${error.message}\n${error.stack}`
    }
    else if(error.message) {
        logMessage = `${message}: ${error.message}`
    }
    else {
        logMessage = `${message}: ${error}`;
    }

    console.error(`${timestamp} ERROR ${logMessage}`);
}

/**
 * Gets the list of namespaces with the matching label.
 * 
 * @returns {Promise<Array<string>>} the names of the matching namespaces.
 */
function getNamespaces() {
    return k8sApi.listNamespace(null, false, null, null, labelSelector).then(response => {
        checkStatus(response.response, () => `Failed to list namespaces: statusCode=${response.response.statusCode}, statusMessage=${response.response.statusMessage}`);
        return response.body.items.map(ns => ns.metadata.name);
    });
}

/**
 * Gets the Docker credentials for the ECR repositories.
 * 
 * @returns {Promise<string>} the value of the '.dockerconfigjson' field in the generated secret.
 */
function fetchDockerCredentials() {
    const client = new ECRClient({region: process.env.AWS_DEFAULT_REGION});
    const params = {};
    const command = new GetAuthorizationTokenCommand(params);
    return client.send(command).then(response => {
        client.destroy();

        const token = response.authorizationData && response.authorizationData.length ?
            response.authorizationData[0].authorizationToken : null;
        const dockerConfig = {
            auths: {}
        };

        if (token) {
            dockerConfig.auths[registry] = {
                username: 'AWS',
                password: token
            };
        }

        return Buffer.from(JSON.stringify(dockerConfig), 'utf8').toString('base64');
    });
}

/**
 * Gets the Docker credentials for the ECR repositories.
 * 
 * @param {boolean} [useCache] true to use the cached value or false to fetch a new value.
 * 
 * @returns {Promise<string>} the value of the '.dockerconfigjson' field in the generated secret.
 */
function getDockerCredentials(useCache) {
    if(useCache && !!cachedToken) {
        const age = differenceInMinutes(new Date(), cachedToken.date);

        if(age < 360) {
            return Promise.resolve(cachedToken.token);
        }
    }

    return fetchDockerCredentials().then(token => {
        cachedToken = {
            token: token,
            date: new Date()
        };
        return token;
    });
}

/**
 * Determines if a namespace contains the ECR secret.
 * 
 * @param {string} namespace the name of the namespace to check.
 * 
 * @returns {Promise<boolean>} true if the secret exists or false if it does not.
 */
function secretExists(namespace) {
    return k8sApi.listNamespacedSecret(namespace)
    .then(response => {
        checkStatus(response.response, () => `Failed to list secrets in namespace ${namespace}: statusCode=${response.response.statusCode}, statusMessage=${secretsResponse.response.statusMessage}`);
        return response.body.items.some(
            config => !!config.metadata && config.metadata.name === secretName);
    });
}

/**
 * Updates an existing ECR secret with new credentials.
 * 
 * @param {string} namespace the name of the namespace to update.
 * @param {string} token the new authentication data.
 * 
 * @returns {Promise} an empty promise for error handling.
 */
function updateSecret(namespace, token) {
    logInfo(`Updating secret in ${namespace}`)
    const patch = [
        {
            op: 'replace',
            path: '/data/.dockerconfigjson',
            value: token
        }
    ];
    const options = {
        headers: {
            "Content-type": k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH
        }
    };
    return k8sApi.patchNamespacedSecret(secretName, namespace, patch, undefined, undefined, undefined, undefined, options).then(response => {
        checkStatus(response.response, () => `Failed to update secret in namespace ${namespace}: statusCode=${response.response.statusCode}, statusMessage=${response.response.statusMessage}`);
    });
}

/**
 * Creates a new ECR secret.
 * 
 * @param {string} namespace the name of the namespace to update.
 * @param {string} token the authentication data.
 * 
 * @returns {Promise} an empty promise for error handling.
 */
function createSecret(namespace, token) {
    logInfo(`Creating secret in ${namespace}`)
    const secret = {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'kubernetes.io/dockerconfigjson',
        metadata: {
            name: secretName,
            namespace: namespace
        },
        data: {
            '.dockerconfigjson': token
        }
    };
    return k8sApi.createNamespacedSecret(namespace, secret).then(response => {
        checkStatus(response.response, () => `Failed to create secret in namespace ${namespace}: statusCode=${response.response.statusCode}, statusMessage=${response.response.statusMessage}`);
    });
}

/**
 * Updates the secret containing the Docker registry credentials in the specified namespace.
 * 
 * @param {string} namespace the name of the namespace to be updated.
 * @param {string} token the authorization token.
 */
function updateNamespaceCredentials(namespace, token) {
    secretExists(namespace)
        .then(exists => {
            if (exists) {
                return updateSecret(namespace, token);
            }
            else {
                return createSecret(namespace, token);
            }
        })
        .catch(error => {
            logError(`Failed to update credentials in namespace ${namespace}`, error);
        });
}

/**
 * Updates the secret containing the Docker registry credentials in all labeled namespaces.
 */
function updateCredentials() {
    getNamespaces().then(namespaces => {
        return getDockerCredentials().then(token => [namespaces, token]);
    })
    .then(([namespaces, token]) => {
        if(namespaces) {
            namespaces.forEach(namespace => updateNamespaceCredentials(namespace, token));
        }
    })
    .catch(error => {
        logError('Failed to update credentials', error);
    });
}

/**
 * Callback that is invoked when a namespace event occurs.
 * 
 * @param {string} phase the type of watch event.
 * @param {object} apiObj the namespace that changed.
 */
function onNamespaceWatchEvent(phase, apiObj) {
    if (phase === 'ADDED') {
        getDockerCredentials(true).then(token => {
            updateNamespaceCredentials(apiObj.metadata.name, token);
        })
        .catch(error => {
            logError('Failed to create secret in new namespace', error);
        });
    }
}

/**
 * Callback this is invoked when the namespace watch completes.
 * 
 * @param {object} error the error condition, if any.
 */
function onNamespaceWatchComplete(error) {
    if (error) {
        logError('Namespace watch failed', error);
    }
    else {
        logInfo('Namespace watch ended');
    }

    // restart watch if connection is broken
    watchNamespaces();
}

/**
 * Watches for namespaces being created.
 */
function watchNamespaces() {
    const watch = new k8s.Watch(k8sConfig);
    watch.watch('/api/v1/namespaces', { labelSelector: labelSelector },
        onNamespaceWatchEvent, onNamespaceWatchComplete);
}

/**
 * Schedules periodic updates of the credentials.
 */
function scheduleUpdates() {
    cron.schedule(cronSchedule, updateCredentials);
}

watchNamespaces();
scheduleUpdates();
