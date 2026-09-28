const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Base uploads directory
const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_ROOT)) {
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

// Multer Storage Configuration structured for future S3 migration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userFolder = path.join(UPLOADS_ROOT, `user_${req.user.id}`);
    if (!fs.existsSync(userFolder)) {
      fs.mkdirSync(userFolder, { recursive: true });
    }
    cb(null, userFolder);
  },
  filename: (req, file, cb) => {
    // Sanitize filename and prepend unique timestamp
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, `${uniqueSuffix}_${cleanName}`);
  }
});

// File filter: Accepted formats: .csv, .xls, .xlsx ONLY
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.csv', '.xls', '.xlsx'];

  const allowedMimeTypes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'application/csv',
    'text/comma-separated-values'
  ];

  if (!allowedExtensions.includes(ext)) {
    const error = new Error('Invalid file format. Accepted formats are .csv, .xls, and .xlsx ONLY.');
    error.code = 'INVALID_FILE_TYPE';
    return cb(error, false);
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50 MB max
  }
});

// -------------------------------------------------------------
// 1. UPLOAD DATASET
// -------------------------------------------------------------
router.post('/upload', authenticateToken, (req, res) => {
  upload.single('dataset')(req, res, async (err) => {
    if (err) {
      if (err.code === 'INVALID_FILE_TYPE') {
        return res.status(400).json({
          success: false,
          message: err.message
        });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File size exceeds maximum limit of 50 MB.'
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || 'File upload error.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded. Please select a valid .csv, .xls, or .xlsx file.'
      });
    }

    try {
      const { originalname, size, mimetype, path: filePath } = req.file;
      const ext = path.extname(originalname).toLowerCase().replace('.', '');
      const relativeStoragePath = path.relative(path.join(__dirname, '..', '..'), filePath).replace(/\\/g, '/');

      const insertRes = await db.query(
        `INSERT INTO uploaded_datasets (user_id, file_name, file_type, file_size, storage_path, uploaded_at, status)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, 'ready')
         RETURNING id, user_id, file_name, file_type, file_size, storage_path, uploaded_at, status`,
        [req.user.id, originalname, ext, size, relativeStoragePath]
      );

      const savedDataset = insertRes.rows[0];

      return res.status(201).json({
        success: true,
        message: 'Dataset uploaded and registered successfully.',
        dataset: savedDataset
      });
    } catch (dbErr) {
      console.error('[Dataset DB Error]', dbErr);
      // Clean up uploaded file if DB insertion failed
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      return res.status(500).json({
        success: false,
        message: 'Failed to record dataset in database.'
      });
    }
  });
});

// -------------------------------------------------------------
// 2. LIST DATASETS
// -------------------------------------------------------------
router.get('/', authenticateToken, async (req, res) => {
  try {
    const listRes = await db.query(
      `SELECT id, file_name, file_type, file_size, storage_path, uploaded_at, status
       FROM uploaded_datasets
       WHERE user_id = $1
       ORDER BY uploaded_at DESC`,
      [req.user.id]
    );

    return res.json({
      success: true,
      datasets: listRes.rows
    });
  } catch (err) {
    console.error('[List Datasets Error]', err);
    return res.status(500).json({ success: false, message: 'Could not fetch datasets.' });
  }
});

// -------------------------------------------------------------
// 3. REMOVE / DELETE DATASET
// -------------------------------------------------------------
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const datasetId = parseInt(req.params.id, 10);
    if (isNaN(datasetId)) {
      return res.status(400).json({ success: false, message: 'Invalid dataset ID.' });
    }

    // Verify ownership
    const checkRes = await db.query(
      'SELECT * FROM uploaded_datasets WHERE id = $1 AND user_id = $2',
      [datasetId, req.user.id]
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Dataset not found or unauthorized.' });
    }

    const dataset = checkRes.rows[0];
    const absolutePath = path.join(__dirname, '..', '..', dataset.storage_path);

    // Delete record from database
    await db.query('DELETE FROM uploaded_datasets WHERE id = $1', [datasetId]);

    // Delete file from disk if exists
    if (fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (fsErr) {
        console.warn(`[File Delete Warning] Could not remove physical file ${absolutePath}:`, fsErr.message);
      }
    }

    return res.json({
      success: true,
      message: 'Dataset deleted successfully.'
    });
  } catch (err) {
    console.error('[Delete Dataset Error]', err);
    return res.status(500).json({ success: false, message: 'Failed to delete dataset.' });
  }
});

module.exports = router;
