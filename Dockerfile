FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Create storage directories
RUN mkdir -p /data/document-storage/raw/google-drive
RUN mkdir -p /data/document-storage/raw/local-uploads
RUN mkdir -p /data/document-storage/raw/other-sources
RUN mkdir -p /data/document-storage/processed
RUN mkdir -p /data/document-storage/temp

VOLUME ["/data/document-storage"]

EXPOSE 3000

CMD ["node", "file-service.js"]