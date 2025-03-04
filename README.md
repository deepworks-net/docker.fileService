# Document File Service

A microservice for managing document storage, designed to handle large volumes of files with metadata tracking in SQL Server.

## Features

- File upload with automatic deduplication
- File metadata storage in SQL Server
- File download and retrieval
- File metadata updates
- Event tracking for all file operations
- Pagination and filtering for file listings
- Scalable architecture for handling large media files

## Prerequisites

- Docker and Docker Compose
- SQL Server instance with the DocumentMetadata database
- Network connectivity between the service and SQL Server

## Quick Start

1. Clone this repository
2. Configure your environment variables in `.env` file
3. Start the service with Docker Compose:

```bash
docker-compose up -d
```

## API Endpoints

### Upload a File

```
POST /upload
```

Form data:
- `file`: The file to upload
- `sourceType`: Source of the file (e.g., 'google-drive', 'local-uploads')
- `fileId` (optional): Custom ID for the file
- `deduplicationEnabled` (optional): Set to 'false' to force upload even if duplicate

### Download a File

```
GET /download/:fileId
```

### Get File Metadata

```
GET /info/:fileId
```

### List Files

```
GET /files?page=1&limit=20&sourceType=google-drive&mimeType=application/pdf&search=keyword
```

### Update File Metadata

```
PATCH /files/:fileId
```

Body:
```json
{
  "tags": ["important", "document"],
  "metadata": {
    "category": "invoice",
    "department": "finance"
  },
  "processing_status": "processed"
}
```

### Delete a File

```
DELETE /files/:fileId
```

### Get File Events

```
GET /files/:fileId/events
```

## Configuration

Configuration is done through environment variables:

- `DB_USER`: SQL Server username
- `DB_PASSWORD`: SQL Server password
- `DB_SERVER`: SQL Server hostname or IP
- `DB_NAME`: Database name
- `STORAGE_ROOT`: Root directory for file storage
- `MAX_FILE_SIZE`: Maximum allowed file size in bytes
- `PORT`: Port to run the service on
- `NODE_ENV`: Environment (development/production)

## Integration with n8n

To use this service with n8n:

1. Use the n8n HTTP Request node to interact with the file service
2. For uploads, use a multipart/form-data POST request to `/upload`
3. For retrieval, use GET requests to `/download/:fileId` or `/info/:fileId`

Example n8n workflow for file upload:

```json
{
  "nodes": [
    {
      "parameters": {
        "url": "http://file-service:3000/upload",
        "method": "POST",
        "bodyParametersUi": {
          "parameter": [
            {
              "name": "sourceType",
              "value": "google-drive"
            },
            {
              "name": "fileId",
              "value": "={{$node[\"Get File\"].json.id}}"
            }
          ]
        },
        "options": {
          "formData": {
            "file": "={{$binary[$node[\"Get File\"].json.name]}}"
          }
        }
      },
      "name": "Upload File",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 1
    }
  ]
}
```

## Directory Structure

The service organizes files in the following structure:

```
/data/document-storage/
├── raw/                   # Original files, unchanged
│   ├── google-drive/      # Files from Google Drive
│   ├── local-uploads/     # Locally uploaded files
│   └── other-sources/     # Other sources
├── processed/             # Processed versions of files
└── temp/                  # Temporary processing area
```

## Database Schema

The service expects the following tables in the SQL Server database:

```sql
CREATE TABLE documents (
  id INT IDENTITY(1,1) PRIMARY KEY,
  file_id VARCHAR(255) UNIQUE NOT NULL,
  file_name NVARCHAR(MAX) NOT NULL,
  file_path NVARCHAR(MAX),
  source_type VARCHAR(50) NOT NULL,
  source_location NVARCHAR(MAX),
  mime_type VARCHAR(100),
  file_size BIGINT,
  created_at DATETIME,
  modified_at DATETIME,
  ingested_at DATETIME DEFAULT GETDATE(),
  content_hash VARCHAR(64),
  processing_status VARCHAR(20) DEFAULT 'raw',
  raw_storage_path NVARCHAR(MAX),
  metadata NVARCHAR(MAX),
  tags NVARCHAR(MAX),
  parent_id INT REFERENCES documents(id)
);

CREATE TABLE document_events (
  id INT IDENTITY(1,1) PRIMARY KEY,
  document_id INT REFERENCES documents(id),
  event_type VARCHAR(50) NOT NULL,
  event_timestamp DATETIME DEFAULT GETDATE(),
  event_data NVARCHAR(MAX),
  user_id VARCHAR(100)
);
```

## Scaling and Future Improvements

This service is designed to be extended for handling terabytes of media files:

1. **Chunked uploads**: For large files, implement resumable uploads
2. **Content distribution**: Add CDN support for faster downloads
3. **Media processing**: Add image/video processing capabilities
4. **Advanced search**: Implement full-text search for document content
5. **Versioning**: Track document versions and changes
6. **Authentication**: Add user authentication and access control

## Troubleshooting

Common issues:

1. **Database connection errors**: Ensure SQL Server is reachable and credentials are correct
2. **Permission issues**: Check file system permissions on storage directories
3. **File size limits**: Adjust MAX_FILE_SIZE environment variable for larger files

Check logs at `./logs` for detailed error information.