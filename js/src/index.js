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

const registry = process.env.DOCKER_REGISTRY;

const k8sConfig = new k8s.KubeConfig();
k8sConfig.loadFromDefault();

const k8sOptions = {};
k8sConfig.applyToRequest(k8sOptions);

const k8sApi = k8sConfig.makeApiClient(k8s.CoreV1Api);

function getNamespaces() {
    k8sApi.listNamespace(null, false, null, null, 'credentialType=ecr').then(response => {
        return response.body.items.map(ns => ns.metadata.name);
    });
}

function getDockerCredentials() {
    const client = new ECRClient({});
    const params = {};
    const command = new GetAuthorizationTokenCommand(params);
    return client.send(command).then(response => {
        client.destroy();

        const token = response.authorizationData && response.authorizationData.length ? response.authorizationData[0].authorizationToken : null;
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

async function updateNamespaceCredentials(namespace, token) {
    var response = await k8sApi.listNamespacedConfigMap(namespace);
    var response = await k8sApi.readNamespacedConfigMap('ecr-creds', namespace);
    const exists = response.body.items.some(config => !!config.metadata && config.metadata.name === 'ecr-creds');
    var config;

    if (exists) {
        config = {
            data: {
                ".dockerconfigjson": token
            }
        };
    }
    else {
        config = {
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
                name: "ecr-creds",
                namespace: namespace
            },
            data: {
                ".dockerconfigjson": token
            },
            type: "kubernetes.io/dockerconfigjson"
        };
    }

    if (exists) {
        await k8sApi.patchNamespacedConfigMap('ecr-creds', namespace, config);
    }
    else {
        await k8sApi.createNamespacedConfigMap(namespace, config);
    }
}

async function updateCredentials() {
    const namespaces = await getNamespaces();
    const token = await getDockerCredentials();
    namespaces.forEach(namespace => updateNamespaceCredentials(namespace, token));
}

updateCredentials(namespaces);
