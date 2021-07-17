FROM node:14-alpine
ENV ECR_SECRET_NAME=ecr-creds
COPY js/ /var/app/
WORKDIR /var/app/
RUN npm ci --only=production
CMD ["node", "js/index.js"]
