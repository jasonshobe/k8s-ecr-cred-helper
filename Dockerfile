FROM node:14-alpine

ENV ECR_SECRET_NAME=ecr-creds
ENV ECR_LABEL_NAME=credentialType
ENV ECR_LABEL_VALUE=ecr
ENV ECR_CRON_SCHEDULE="0 */6 * * *"

COPY js/ /var/app/

WORKDIR /var/app/

RUN npm ci --only=production

CMD ["node", "src/index.js"]
