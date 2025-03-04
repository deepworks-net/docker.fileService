// file-service.js - Main application file
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const sql = require('mssql');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'file-service' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// Create logs directory if it doesn't exist
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(helmet()); // Security headers
app.use(cors());   // Enable CORS for all routes
app.use(morgan('combined')); // HTTP request logging
app.use(express.json()); // Parse JSON bodies

// SQL Server configuration
const sqlConfig = {
  user: process.env.DB_USER || 'n8n_login',
  password: process.env.DB_PASSWORD || 'YourStrongPassword123!',
  server: process.env.DB_SERVER || 'localhost',
  database: process.env.DB_NAME || 'DocumentMetadata',
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true
  }
};

// Initialize database connection pool
const pool = new sql.ConnectionPool(sqlConfig);
const poolConnect = pool.connect();

// Handle pool connection errors
poolConnect.catch(err => {
  logger.error('Error connecting to database:', err);
});

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const sourceType = req.body.sourceType || 'other-sources';
    const dir = path.join(process.env.STORAGE_ROOT || '/data/document-storage/raw', sourceType);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Use provided ID if available, otherwise generate unique filename
    const fileName = req.body.fileId || `${Date.now()}-${file.originalname}`;
    cb(null, fileName);
  }
});

// Configure upload limits
const upload = multer({ 
  storage,
  limits: {
    fileSize: process.env.MAX_FILE_SIZE || 5000 * 1024 * 1024 // Default 5GB
  }
});

// Error handler middleware
const errorHandler = (err, req, res, next) => {
  logger.error(`Error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'Server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
};

// Helper to record file event in database
async function recordFileEvent(fileInfo, eventType) {
  try {
    await poolConnect;
    
    // Record the file metadata
    const documentResult = await pool.request()
      .input('file_id', sql.VarChar, fileInfo.id)
      .input('file_name', sql.NVarChar, fileInfo.originalName)
      .input('source_type', sql.VarChar, fileInfo.sourceType)
      .input('source_location', sql.NVarChar, fileInfo.sourceLocation || '')
      .input('mime_type', sql.VarChar, fileInfo.mimeType)
      .input('file_size', sql.BigInt, fileInfo.size)
      .input('created_at', sql.DateTime, new Date())
      .input('modified_at', sql.DateTime, new Date())
      .input('content_hash', sql.VarChar, fileInfo.hash)
      .input('raw_storage_path', sql.NVarChar, fileInfo.storagePath)
      .input('metadata', sql.NVarChar, JSON.stringify(fileInfo.metadata || {}))
      .input('tags', sql.NVarChar, JSON.stringify([]))
      .query(`
        MERGE INTO documents AS target
        USING (SELECT @file_id as file_id) AS source
        ON target.file_id = source.file_id
        WHEN MATCHED THEN
          UPDATE SET 
            file_name = @file_name,
            mime_type = @mime_type,
            file_size = @file_size,
            modified_at = @modified_at,
            content_hash = @content_hash,
            raw_storage_path = @raw_storage_path,
            metadata = @metadata
        WHEN NOT MATCHED THEN
          INSERT (file_id, file_name, source_type, source_location, mime_type, file_size, 
                 created_at, modified_at, content_hash, raw_storage_path, metadata, tags)
          VALUES (@file_id, @file_name, @source_type, @source_location, @mime_type, @file_size,
                 @created_at, @modified_at, @content_hash, @raw_storage_path, @metadata, @tags);
        
        SELECT id FROM documents WHERE file_id = @file_id;
      `);
    
    const documentId = documentResult.recordset[0].id;
    
    // Record the event
    await pool.request()
      .input('document_id', sql.Int, documentId)
      .input('event_type', sql.VarChar, eventType)
      .input('event_data', sql.NVarChar, JSON.stringify(fileInfo))
      .query(`
        INSERT INTO document_events (document_id, event_type, event_data)
        VALUES (@document_id, @event_type, @event_data);
      `);
      
    return documentId;
  } catch (err) {
    logger.error('Database error:', err);
    throw err;
  }
}

// Check if file already exists by hash
async function checkFileExists(hash) {
  try {
    await poolConnect;
    const result = await pool.request()
      .input('content_hash', sql.VarChar, hash)
      .query('SELECT id, file_id, raw_storage_path FROM documents WHERE content_hash = @content_hash');
    
    if (result.recordset.length > 0) {
      return result.recordset[0];
    }
    return null;
  } catch (err) {
    logger.error('Error checking file existence:', err);
    throw err;
  }
}

// API ENDPOINTS

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// File upload endpoint
app.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }
    
    // Calculate file hash
    const fileBuffer = fs.readFileSync(req.file.path);
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    // Check if file already exists by hash
    const existingFile = await checkFileExists(hash);
    
    if (existingFile && req.body.deduplicationEnabled !== 'false') {
      // Delete the uploaded file since we already have it
      fs.unlinkSync(req.file.path);
      
      logger.info(`Duplicate file detected: ${req.file.originalname} matches existing file ${existingFile.file_id}`);
      
      return res.json({
        success: true,
        duplicateDetected: true,
        file: {
          id: existingFile.file_id,
          originalName: req.file.originalname,
          storagePath: existingFile.raw_storage_path,
          existingId: existingFile.id,
          mimeType: req.file.mimetype,
          size: req.file.size,
          hash: hash
        }
      });
    }
    
    // Prepare file info
    const fileInfo = {
      id: req.body.fileId || path.basename(req.file.path),
      originalName: req.file.originalname,
      storagePath: req.file.path,
      mimeType: req.file.mimetype,
      size: req.file.size,
      hash: hash,
      sourceType: req.body.sourceType || 'other-sources',
      sourceLocation: req.body.sourceLocation,
      metadata: {
        ...req.body,
        uploadedAt: new Date()
      }
    };
    
    // Record file in database
    const documentId = await recordFileEvent(fileInfo, 'uploaded');
    
    res.json({
      success: true,
      documentId: documentId,
      file: fileInfo
    });
  } catch (error) {
    next(error);
  }
});

// File download endpoint
app.get('/download/:fileId', async (req, res, next) => {
  try {
    await poolConnect;
    const result = await pool.request()
      .input('file_id', sql.VarChar, req.params.fileId)
      .query('SELECT raw_storage_path, file_name FROM documents WHERE file_id = @file_id');
    
    if (result.recordset.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found' 
      });
    }
    
    const filePath = result.recordset[0].raw_storage_path;
    const fileName = result.recordset[0].file_name;
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        success: false, 
        message: 'File content not found on disk' 
      });
    }
    
    // Log download event
    await recordFileEvent(
      { id: req.params.fileId, metadata: { downloadedBy: req.query.user || 'anonymous' } },
      'downloaded'
    );
    
    res.download(filePath, fileName);
  } catch (error) {
    next(error);
  }
});

// File metadata endpoint
app.get('/info/:fileId', async (req, res, next) => {
  try {
    await poolConnect;
    const result = await pool.request()
      .input('file_id', sql.VarChar, req.params.fileId)
      .query(`
        SELECT d.*, 
               (SELECT COUNT(*) FROM document_events WHERE document_id = d.id) as event_count
        FROM documents d
        WHERE d.file_id = @file_id
      `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found' 
      });
    }
    
    // Parse JSON fields
    const fileInfo = result.recordset[0];
    try {
      fileInfo.metadata = JSON.parse(fileInfo.metadata);
      fileInfo.tags = JSON.parse(fileInfo.tags);
    } catch (e) {
      logger.warn(`Error parsing JSON fields for file ${req.params.fileId}`, e);
    }
    
    res.json({
      success: true,
      file: fileInfo
    });
  } catch (error) {
    next(error);
  }
});

// List files endpoint with filtering and pagination
app.get('/files', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    let query = 'SELECT * FROM documents';
    let countQuery = 'SELECT COUNT(*) as total FROM documents';
    let whereClause = '';
    const params = [];
    
    // Build filter conditions
    if (req.query.sourceType) {
      whereClause += whereClause ? ' AND ' : ' WHERE ';
      whereClause += 'source_type = @sourceType';
      params.push({ name: 'sourceType', type: sql.VarChar, value: req.query.sourceType });
    }
    
    if (req.query.mimeType) {
      whereClause += whereClause ? ' AND ' : ' WHERE ';
      whereClause += 'mime_type LIKE @mimeType';
      params.push({ name: 'mimeType', type: sql.VarChar, value: '%' + req.query.mimeType + '%' });
    }
    
    // Add search by filename
    if (req.query.search) {
      whereClause += whereClause ? ' AND ' : ' WHERE ';
      whereClause += 'file_name LIKE @search';
      params.push({ name: 'search', type: sql.NVarChar, value: '%' + req.query.search + '%' });
    }
    
    // Complete the queries
    query += whereClause + ' ORDER BY ingested_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY';
    countQuery += whereClause;
    
    await poolConnect;
    const request = pool.request();
    
    // Add parameters
    params.forEach(param => {
      request.input(param.name, param.type, param.value);
    });
    
    // Add pagination parameters
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);
    
    // Execute queries
    const data = await request.query(query);
    const countResult = await pool.request()
      .input('sourceType', sql.VarChar, req.query.sourceType)
      .input('mimeType', sql.VarChar, req.query.mimeType ? '%' + req.query.mimeType + '%' : '%%')
      .input('search', sql.NVarChar, req.query.search ? '%' + req.query.search + '%' : '%%')
      .query(countQuery);
    
    const total = countResult.recordset[0].total;
    const totalPages = Math.ceil(total / limit);
    
    // Process results - parse JSON fields
    const files = data.recordset.map(file => {
      try {
        file.metadata = JSON.parse(file.metadata);
        file.tags = JSON.parse(file.tags);
      } catch (e) {
        logger.warn(`Error parsing JSON for file ${file.file_id}`, e);
      }
      return file;
    });
    
    res.json({
      success: true,
      pagination: {
        total,
        page,
        limit,
        totalPages
      },
      files
    });
  } catch (error) {
    next(error);
  }
});

// Update file metadata
app.patch('/files/:fileId', async (req, res, next) => {
  try {
    // Validate request
    if (!req.body) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required'
      });
    }
    
    // Prepare update fields
    const updateFields = [];
    const params = [
      { name: 'file_id', type: sql.VarChar, value: req.params.fileId }
    ];
    
    // Handle tags update
    if (req.body.tags) {
      updateFields.push('tags = @tags');
      params.push({ name: 'tags', type: sql.NVarChar, value: JSON.stringify(req.body.tags) });
    }
    
    // Handle metadata update
    if (req.body.metadata) {
      // First get existing metadata
      await poolConnect;
      const existingResult = await pool.request()
        .input('file_id', sql.VarChar, req.params.fileId)
        .query('SELECT metadata FROM documents WHERE file_id = @file_id');
      
      if (existingResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'File not found'
        });
      }
      
      let existingMetadata = {};
      try {
        existingMetadata = JSON.parse(existingResult.recordset[0].metadata);
      } catch (e) {
        logger.warn(`Error parsing metadata for file ${req.params.fileId}`, e);
      }
      
      // Merge existing with new metadata
      const updatedMetadata = { ...existingMetadata, ...req.body.metadata };
      updateFields.push('metadata = @metadata');
      params.push({ name: 'metadata', type: sql.NVarChar, value: JSON.stringify(updatedMetadata) });
    }
    
    // Add other updateable fields
    if (req.body.processing_status) {
      updateFields.push('processing_status = @processing_status');
      params.push({ name: 'processing_status', type: sql.VarChar, value: req.body.processing_status });
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid update fields provided'
      });
    }
    
    // Build and execute update query
    const updateQuery = `
      UPDATE documents 
      SET ${updateFields.join(', ')}, modified_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE file_id = @file_id
    `;
    
    await poolConnect;
    const request = pool.request();
    
    // Add parameters
    params.forEach(param => {
      request.input(param.name, param.type, param.value);
    });
    
    const result = await request.query(updateQuery);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    // Record update event
    await recordFileEvent(
      { 
        id: req.params.fileId, 
        metadata: { 
          updatedFields: Object.keys(req.body),
          updatedBy: req.body.updatedBy || 'system'
        } 
      },
      'updated'
    );
    
    // Parse JSON fields
    const updatedFile = result.recordset[0];
    try {
      updatedFile.metadata = JSON.parse(updatedFile.metadata);
      updatedFile.tags = JSON.parse(updatedFile.tags);
    } catch (e) {
      logger.warn(`Error parsing JSON for updated file ${req.params.fileId}`, e);
    }
    
    res.json({
      success: true,
      file: updatedFile
    });
  } catch (error) {
    next(error);
  }
});

// Delete file endpoint
app.delete('/files/:fileId', async (req, res, next) => {
  try {
    // First get file information
    await poolConnect;
    const fileResult = await pool.request()
      .input('file_id', sql.VarChar, req.params.fileId)
      .query('SELECT id, raw_storage_path FROM documents WHERE file_id = @file_id');
    
    if (fileResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    const fileInfo = fileResult.recordset[0];
    
    // Delete file from storage if it exists
    if (fileInfo.raw_storage_path && fs.existsSync(fileInfo.raw_storage_path)) {
      fs.unlinkSync(fileInfo.raw_storage_path);
    }
    
    // Delete events first (foreign key constraint)
    await pool.request()
      .input('document_id', sql.Int, fileInfo.id)
      .query('DELETE FROM document_events WHERE document_id = @document_id');
    
    // Delete document record
    await pool.request()
      .input('file_id', sql.VarChar, req.params.fileId)
      .query('DELETE FROM documents WHERE file_id = @file_id');
    
    res.json({
      success: true,
      message: 'File and associated data deleted successfully'
    });
  } catch (error) {
    next(error);
  }
});

// Get document events
app.get('/files/:fileId/events', async (req, res, next) => {
  try {
    await poolConnect;
    
    // First check if document exists
    const docResult = await pool.request()
      .input('file_id', sql.VarChar, req.params.fileId)
      .query('SELECT id FROM documents WHERE file_id = @file_id');
    
    if (docResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    const documentId = docResult.recordset[0].id;
    
    // Get events
    const eventsResult = await pool.request()
      .input('document_id', sql.Int, documentId)
      .query(`
        SELECT * FROM document_events
        WHERE document_id = @document_id
        ORDER BY event_timestamp DESC
      `);
    
    // Parse event data
    const events = eventsResult.recordset.map(event => {
      try {
        event.event_data = JSON.parse(event.event_data);
      } catch (e) {
        logger.warn(`Error parsing event data for event ${event.id}`, e);
      }
      return event;
    });
    
    res.json({
      success: true,
      events
    });
  } catch (error) {
    next(error);
  }
});

// Apply error handler
app.use(errorHandler);

// Start server
app.listen(port, () => {
  logger.info(`File service listening on port ${port}`);
  logger.info(`Storage root: ${process.env.STORAGE_ROOT || '/data/document-storage'}`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await pool.close();
  process.exit(0);
});

module.exports = app; // For testing purposes