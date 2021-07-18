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

const registry = process.env.DOCKER_REGISTRY;
const secretName = process.env.ECR_SECRET_NAME;
const labelSelector = `${process.env.ECR_LABEL_NAME}=${process.env.ECR_LABEL_VALUE}`;
const cronSchedule = process.env.ECR_CRON_SCHEDULE;

const k8sConfig = new k8s.KubeConfig();
k8sConfig.loadFromDefault();
const k8sOptions = {};
k8sConfig.applyToRequest(k8sOptions);
const k8sApi = k8sConfig.makeApiClient(k8s.CoreV1Api);

/**
 * Gets the list of namespaces with the matching label.
 * 
 * @returns {Promise<Array<string>>} the names of the matching namespaces.
 */
function getNamespaces() {
    k8sApi.listNamespace(null, false, null, null, labelSelector).then(response => {
        if (response.response.statusCode !== 200) {
            throw new Error(`Failed to list namespaces: statusCode=${response.response.statusCode}, statusMessage=${response.response.statusMessage}`)
        }

        return response.body.items.map(ns => ns.metadata.name);
    });
}

/**
 * Gets the Docker credentials for the ECR repositories.
 * 
 * @returns {Promise<string>} the value of the '.dockerconfigjson' field in the generated secret.
 */
function getDockerCredentials() {
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
 * Updates the secret containing the Docker registry credentials in the specified namespace.
 * 
 * @param {string} namespace the name of the namespace to be updated.
 * @param {string} token the authorization token.
 */
async function updateNamespaceCredentials(namespace, token) {
    var response = await k8sApi.listNamespacedSecret(namespace);

    if (response.response.statusCode !== 200) {
        log.error(`Failed to list secrets in namespace ${namespace}: statusCode=${response.response.statusCode}, statusMessage=${response.response.statusMessage}`)
        return;
    }

    const exists = response.body.items.some(
        config => !!config.metadata && config.metadata.name === secretName);
    var secret;

    if (exists) {
        secret = {
            data: {
                '.dockerconfigjson': token
            }
        };
    }
    else {
        secret = {
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
    }

    if (exists) {
        response = await k8sApi.patchNamespacedSecret(secretName, namespace, secret);
        
        if (response.response.statusCode < 200 || response.response.statusCode >= 300) {
            log.error(`Failed to update secret in namespace ${namespace}: statusCode=${response.response.statusCode}, statusMessage=${response.response.statusMessage}`)
        }
    }
    else {
        response = await k8sApi.createNamespacedSecret(namespace, secret);
        
        if (response.response.statusCode < 200 || response.response.statusCode >= 300) {
            log.error(`Failed to create secret in namespace ${namespace}: statusCode=${response.response.statusCode}, statusMessage=${response.response.statusMessage}`)
        }
    }
}

/**
 * Updates the secret containing the Docker registry credentials in all labeled namespaces.
 */
async function updateCredentials() {
    var namespaces;
    var token;

    try {
        namespaces = await getNamespaces();
    }
    catch(ex) {
        log.error("Failed to list namespaces", ex);
        return;
    }

    try {
        token = await getDockerCredentials();
    }
    catch(ex) {
        log.error("Failed to get Docker credentials", ex);
        return;
    }

    namespaces.forEach(namespace => updateNamespaceCredentials(namespace, token));
}

/**
 * Callback that is invoked when a namespace event occurs.
 * 
 * @param {string} phase the type of watch event.
 * @param {object} apiObj the namespace that changed.
 */
async function onNamespaceWatchEvent(phase, apiObj) {
    if (phase === 'ADDED') {
        var token;

        try {
            token = await getDockerCredentials();
        }
        catch(ex) {
            log.error("Failed to get Docker credentials", ex);
            return;
        }

        updateNamespaceCredentials(apiObj.metadata.name, token);
    }
}

/**
 * Callback this is invoked when the namespace watch completes.
 * 
 * @param {object} error the error condition, if any.
 */
function onNamespaceWatchComplete(error) {
    if (error) {
        console.error('Namespace watch failed: ', error);
    }
    else {
        console.log('Namespace watch ended');
    }
}

const watch = new k8s.Watch(k8sConfig);
watch.watch('/api/v1/namespaces', { labelSelector: labelSelector },
    onNamespaceWatchEvent, onNamespaceWatchComplete);

updateCredentials();

cron.schedule(cronSchedule, updateCredentials);
