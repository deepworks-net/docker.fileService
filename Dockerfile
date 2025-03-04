FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Create storage directories
RUN mkdir -p /data/document-storage/raw/google-drive
RUN mkdir -p /data/document-storage/raw/local-uploads
RUN mkdir -p /data/document-storage/raw/other-sources
RUN mkdir -p /data/document-storage/processed
RUN mkdir -p /data/document-storage/temp
RUN mkdir -p /app/logs

# Set appropriate permissions
RUN chmod -R 755 /data/document-storage
RUN chmod -R 755 /app/logs

# Create volume mount point
VOLUME ["/data/document-storage"]

# Expose the port
EXPOSE 3000

# Run the application
CMD ["node", "file-service.js"]