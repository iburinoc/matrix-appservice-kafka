FROM node:14.16

WORKDIR /app
ADD package.json package-lock.json /app/

RUN npm ci

ADD index.js /app/

ENTRYPOINT ["node", "index.js", "-p", "9002"]
