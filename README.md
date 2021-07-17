# ECR Credentials Helper for Kubernetes

A utility to update a Docker registry secret for AWS ECR repositories in all
labeled namespaces. The image is intended to be deployed as a pod in
Kuberentes.

When the pod starts, all the secret file in each labeled namespace is
updated. The secret files are then updated on the defined schedule (every six
hours by default). The pod also watches for any labeled namespaces being
created in order to create the secret file.

## How to this image

Target namespaces should have the label `credentialType` set to `ecr`. The
label name and value can be changed with the `ECR_LABEL_NAME` and
`ECR_LABEL_VALUE` environment variables, respectively. For example,

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
  labels:
    credentialType: ecr
```

Create a secret containing the AWS credentials:

```shell
kubectl create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID=your_access_key_id \
  --from-literal=AWS_SECRET_ACCESS_KEY=your_secret_access_key
```

Create a cluster role and service account for the job:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ecr-cred-helper
rules:
- apiGroups: [""]
  resources: ["namespaces", "configmaps"]
  verbs: ["get", "list", "watch", "create", "patch"]
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ecr-cred-helper
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ecr-cred-helper-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ecr-cred-helper
subjects:
- kind: ServiceAccount
  name: ecr-cred-helper
```

Create the deployment for the pod:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ecr-cred-helper
  labels:
    app: ecr-cred-helper
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ecr-cred-helper
  template:
    metadata:
      labels:
        app: ecr-cred-helper
    spec:
      serviceAccountName: ecr-cred-helper
    containers:
    - name: ecr-cred-helper
      image: jasonshobe/k8s-ecr-cred-helper:1.0.0
      imagePullPolicy: IfNotPresent
      env:
      - name: AWS_ACCESS_KEY_ID
        valueFrom:
          secretKeyRef:
            key: AWS_ACCESS_KEY_ID
            name: aws-creds
      - name: AWS_SECRET_ACCESS_KEY
        valueFrom:
          secretKeyRef:
            key: AWS_SECRET_ACCESS_KEY
            name: aws-creds
      - name: AWS_DEFAULT_REGION
        value: us-east-1
      - name: DOCKER_REGISTRY
        value: 000000000000.dkr.ecr.us-east-1.amazonaws.com
```

## Environment Variables

### `AWS_ACCESS_KEY_ID`

The access key ID for the AWS IAM user used to create the authorization
token.

### `AWS_SECRET_ACCESS_KEY`

The secret access key for the AWS IAM user used to create the authorization
token.

### `AWS_DEFAULT_REGION`

The region in which the ECR repositories are hosted.

### `DOCKER_REGISTRY`

The ECR hostname, e.g. `aws_account_id.dkr.ecr.region.amazonaws.com`.

### `ECR_SECRET_NAME`

The name of the secret created in the labeled namespaces. By default,
`ecr-creds` is used.

### `ECR_LABEL_NAME`

The name of the label on namespaces that identify namespaces to be updated.

### `ECR_LABEL_VALUE`

The value of the label on namespaces that identify namespaces to be updated.

### `ECR_CRON_SCHEDULE`

The cronjob schedule string controlling how often the credentials are
updated. By default, it is done every 6 hours using the expression
`0 */6 * * *`.
