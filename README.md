# ECR Credentials Helper for Kubernetes

A utility to update a Docker registry secret for AWS ECR repositories in all
labeled namespaces. The image is intended to be run as a
[Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/).

When the job is run, a Docker registry secret will be created or updated in
each labeled namespace. This secret can be used to pull images from AWS ECR
repositories.

## How to this image

Target namespaces should have the label `credentialType` set to `ecr`. For
example,

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

Create a job that runs every 6 hours:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ecr-cred-helper
spec:
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
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
            - name: ECR_SECRET_NAME
              value: ecr-creds
          restartPolicy: OnFailure
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
