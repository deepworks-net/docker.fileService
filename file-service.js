// file-service.js - Basic Express.js file service
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Configure storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const sourceType = req.body.sourceType || 'other-sources';
    const dir = path.join('/data/document-storage/raw', sourceType);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Use original name or generate unique filename
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage });

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No file uploaded');
    }
    
    // Calculate file hash
    const fileBuffer = fs.readFileSync(req.file.path);
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    // Build response
    const response = {
      success: true,
      file: {
        originalName: req.file.originalname,
        storagePath: req.file.path,
        mimeType: req.file.mimetype,
        size: req.file.size,
        hash: hash,
        metadata: req.body
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).send('Error processing upload');
  }
});

// File download endpoint
app.get('/download/:fileId', (req, res) => {
  // In a real implementation, you'd query your database to get the file path
  // For now, this is a simplified example
  const filePath = path.join('/data/document-storage/raw', req.params.fileId);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  
  res.download(filePath);
});

// File info endpoint
app.get('/info/:fileId', (req, res) => {
  // Again, in a real implementation, query your database
  res.json({ 
    message: 'This would return file metadata from your database' 
  });
});

app.listen(port, () => {
  console.log(`File service listening on port ${port}`);
});