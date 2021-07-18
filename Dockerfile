FROM node:14-alpine AS build
WORKDIR /var/app
COPY js/package.json js/package-lock.json ./
RUN npm ci --only=production

FROM node:14-alpine
WORKDIR /var/app
COPY --from=build /var/app/ ./
COPY js/src ./src
ENV ECR_SECRET_NAME=ecr-creds
ENV ECR_LABEL_NAME=credentialType
ENV ECR_LABEL_VALUE=ecr
ENV ECR_CRON_SCHEDULE="0 */6 * * *"
CMD ["node", "src/index.js"]
