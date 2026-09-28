const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const AGENT_URL = process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:8001';
const PROCESSED_ROOT = path.join(__dirname, '..', '..', 'processed');

if (!fs.existsSync(PROCESSED_ROOT)) {
  fs.mkdirSync(PROCESSED_ROOT, { recursive: true });
}

// Rate Limiter for running preprocessing jobs (20 jobs per 15 min per IP)
const runJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    message: 'Too many preprocessing requests from this IP. Please try again after 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Helper to call internal Python microservice
 */
async function callAgentService(endpoint, body) {
  const url = `${AGENT_URL}${endpoint}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      let errMsg = `Agent service responded with status ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData.detail || errMsg;
      } catch (e) {}
      throw new Error(errMsg);
    }

    return await response.json();
  } catch (err) {
    if (err.cause && (err.cause.code === 'ECONNREFUSED' || err.cause.code === 'ENOTFOUND')) {
      throw new Error(`Data Preprocessing Agent service is unreachable at ${AGENT_URL}. Please ensure the Python service is running.`);
    }
    throw err;
  }
}

/**
 * Resolve dataset and verify user ownership
 */
async function getOwnedDataset(datasetId, userId) {
  const res = await db.query(
    `SELECT id, user_id, file_name, file_type, file_size, storage_path, status
     FROM uploaded_datasets
     WHERE id = $1 AND user_id = $2`,
    [datasetId, userId]
  );
  if (!res.rows || res.rows.length === 0) {
    return null;
  }
  const dataset = res.rows[0];
  const absolutePath = path.resolve(__dirname, '..', '..', dataset.storage_path);
  if (!fs.existsSync(absolutePath)) {
    throw new Error('Dataset file is missing from server storage.');
  }
  return { dataset, absolutePath };
}

// -------------------------------------------------------------
// 1. PROFILE DATASET (Steps 1–4)
// -------------------------------------------------------------
router.post('/profile', authenticateToken, async (req, res) => {
  try {
    const { datasetId, sheet } = req.body;
    if (!datasetId) {
      return res.status(400).json({ success: false, message: 'Dataset ID is required.' });
    }

    const owned = await getOwnedDataset(datasetId, req.user.id);
    if (!owned) {
      return res.status(404).json({ success: false, message: 'Dataset not found or access denied.' });
    }

    // Check sheets if Excel
    let sheetNames = [];
    let isExcel = false;
    try {
      const sheetsRes = await callAgentService('/sheets', { file_path: owned.absolutePath });
      isExcel = sheetsRes.is_excel;
      sheetNames = sheetsRes.sheets || [];
    } catch (e) {
      // Continue if not excel or error
    }

    // Call profile
    const profileRes = await callAgentService('/profile', {
      file_path: owned.absolutePath,
      sheet_name: sheet || (sheetNames.length > 0 ? sheetNames[0] : null)
    });

    return res.json({
      success: true,
      dataset: {
        id: owned.dataset.id,
        file_name: owned.dataset.file_name,
        file_type: owned.dataset.file_type,
        file_size: owned.dataset.file_size
      },
      is_excel: isExcel,
      sheets: sheetNames,
      active_sheet: sheet || (sheetNames.length > 0 ? sheetNames[0] : null),
      profile: profileRes.profile,
      detected_date_column: profileRes.detected_date_column,
      suggested_target_column: profileRes.suggested_target_column,
      standardized_columns: profileRes.standardized_columns,
      numeric_columns: profileRes.numeric_columns,
      recommended_config: profileRes.recommended_config
    });
  } catch (err) {
    console.error('[Preprocessing Profile Error]', err);
    return res.status(400).json({
      success: false,
      message: err.message || 'Failed to inspect dataset.'
    });
  }
});

// -------------------------------------------------------------
// 2. RUN FULL PIPELINE (Steps 1–10)
// -------------------------------------------------------------
router.post('/run', authenticateToken, runJobLimiter, async (req, res) => {
  try {
    const { datasetId, config } = req.body;
    if (!datasetId) {
      return res.status(400).json({ success: false, message: 'Dataset ID is required.' });
    }

    const owned = await getOwnedDataset(datasetId, req.user.id);
    if (!owned) {
      return res.status(404).json({ success: false, message: 'Dataset not found or access denied.' });
    }

    // Validate config values
    const safeConfig = config || {};
    const validOutlierMethods = ['iqr', 'zscore'];
    const validOutlierActions = ['cap', 'flag', 'none'];
    const validAggMethods = ['sum', 'mean', 'max', 'min', 'first'];

    if (safeConfig.outlier_method && !validOutlierMethods.includes(safeConfig.outlier_method.toLowerCase())) {
      safeConfig.outlier_method = 'iqr';
    }
    if (safeConfig.outlier_action && !validOutlierActions.includes(safeConfig.outlier_action.toLowerCase())) {
      safeConfig.outlier_action = 'cap';
    }
    if (safeConfig.duplicate_aggregation && !validAggMethods.includes(safeConfig.duplicate_aggregation.toLowerCase())) {
      safeConfig.duplicate_aggregation = 'sum';
    }
    const missingThreshold = parseFloat(safeConfig.missing_threshold);
    safeConfig.missing_threshold = (!isNaN(missingThreshold) && missingThreshold > 0 && missingThreshold <= 100) ? missingThreshold : 60.0;

    const jobId = crypto.randomUUID();
    const outputDir = path.join(PROCESSED_ROOT, `user_${req.user.id}`, jobId);

    // Create job record in queued status
    await db.query(
      `INSERT INTO processing_jobs (id, user_id, dataset_id, status, config_json, created_at)
       VALUES ($1, $2, $3, 'queued', $4, CURRENT_TIMESTAMP)`,
      [jobId, req.user.id, datasetId, JSON.stringify(safeConfig)]
    );

    // Asynchronously execute pipeline
    (async () => {
      try {
        await db.query(
          `UPDATE processing_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [jobId]
        );

        const result = await callAgentService('/process', {
          file_path: owned.absolutePath,
          user_id: String(req.user.id),
          job_id: jobId,
          output_dir: outputDir,
          config: safeConfig
        });

        // Insert processed dataset record
        const relativeCsvPath = path.relative(path.join(__dirname, '..', '..'), result.cleaned_csv_path).replace(/\\/g, '/');
        await db.query(
          `INSERT INTO processed_datasets (
             id, job_id, user_id, source_dataset_id, file_path,
             rows_before, rows_after, columns_before, columns_after,
             date_column, target_column, frequency,
             quality_score_before, quality_score_after, readiness_score,
             created_at
           ) VALUES (
             gen_random_uuid(), $1, $2, $3, $4,
             $5, $6, $7, $8,
             $9, $10, $11,
             $12, $13, $14,
             CURRENT_TIMESTAMP
           )`,
          [
            jobId, req.user.id, datasetId, relativeCsvPath,
            result.rows_before, result.rows_after, result.columns_before, result.columns_after,
            result.date_column, result.target_column, result.frequency,
            result.quality_score_before, result.quality_score_after, result.readiness_score
          ]
        );

        // Bulk insert audit logs into cleaning_actions
        if (Array.isArray(result.audit_log) && result.audit_log.length > 0) {
          for (const item of result.audit_log) {
            await db.query(
              `INSERT INTO cleaning_actions (
                 job_id, step_order, step_name, column_name, action, method, rows_affected, description, created_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
              [
                jobId,
                item.step_order || 1,
                item.step_name || 'STEP',
                item.column_name || 'ALL',
                item.action || 'MODIFY',
                item.method || 'STANDARD',
                item.rows_affected || 0,
                item.description || ''
              ]
            );
          }
        }

        await db.query(
          `UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [jobId]
        );
      } catch (execErr) {
        console.error(`[Preprocessing Async Job ${jobId} Error]`, execErr);
        await db.query(
          `UPDATE processing_jobs SET status = 'failed', error_message = $2, finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [jobId, execErr.message || 'Processing failed.']
        );
      }
    })();

    return res.status(202).json({
      success: true,
      jobId,
      status: 'queued',
      message: 'Preprocessing job scheduled successfully.'
    });
  } catch (err) {
    console.error('[Preprocessing Run Error]', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to start preprocessing job.'
    });
  }
});

// -------------------------------------------------------------
// 3. JOB STATUS (for polling)
// -------------------------------------------------------------
router.get('/jobs/:jobId', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobRes = await db.query(
      `SELECT id, dataset_id, status, error_message, started_at, finished_at, created_at
       FROM processing_jobs
       WHERE id = $1 AND user_id = $2`,
      [jobId, req.user.id]
    );

    if (!jobRes.rows || jobRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Job not found or access denied.' });
    }

    return res.json({
      success: true,
      job: jobRes.rows[0]
    });
  } catch (err) {
    console.error('[Get Job Status Error]', err);
    return res.status(500).json({ success: false, message: 'Could not fetch job status.' });
  }
});

// -------------------------------------------------------------
// 4. FULL REPORT
// -------------------------------------------------------------
router.get('/jobs/:jobId/report', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobRes = await db.query(
      `SELECT j.id, j.dataset_id, j.status, j.config_json, j.error_message, j.started_at, j.finished_at, j.created_at,
              d.file_name as source_filename
       FROM processing_jobs j
       JOIN uploaded_datasets d ON j.dataset_id = d.id
       WHERE j.id = $1 AND j.user_id = $2`,
      [jobId, req.user.id]
    );

    if (!jobRes.rows || jobRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Job not found or access denied.' });
    }

    const job = jobRes.rows[0];
    if (job.status !== 'completed') {
      return res.json({
        success: true,
        job,
        report: null,
        message: `Job is currently ${job.status}`
      });
    }

    const datasetRes = await db.query(
      `SELECT * FROM processed_datasets WHERE job_id = $1`,
      [jobId]
    );

    const actionsRes = await db.query(
      `SELECT step_order, step_name, column_name, action, method, rows_affected, description, created_at
       FROM cleaning_actions
       WHERE job_id = $1
       ORDER BY step_order ASC, id ASC`,
      [jobId]
    );

    // Read report JSON from disk for structured checklist & preview
    let diskReport = {};
    const reportPath = path.join(PROCESSED_ROOT, `user_${req.user.id}`, jobId, 'report.json');
    if (fs.existsSync(reportPath)) {
      try {
        diskReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch (e) {}
    }

    const datasetInfo = datasetRes.rows[0] || {};

    return res.json({
      success: true,
      job,
      dataset: datasetInfo,
      audit_log: actionsRes.rows,
      readiness: {
        score: datasetInfo.readiness_score,
        overall_status: diskReport.overall_status || (datasetInfo.readiness_score >= 80 ? 'READY' : 'WARN'),
        checklist: diskReport.checklist || []
      },
      quality: {
        before: datasetInfo.quality_score_before,
        after: datasetInfo.quality_score_after,
        improvement_pct: datasetInfo.quality_score_before > 0
          ? Math.round(((datasetInfo.quality_score_after - datasetInfo.quality_score_before) / datasetInfo.quality_score_before) * 100)
          : 0
      },
      sample_cleaned_data: diskReport.sample_cleaned_data || []
    });
  } catch (err) {
    console.error('[Get Job Report Error]', err);
    return res.status(500).json({ success: false, message: 'Could not fetch job report.' });
  }
});

// -------------------------------------------------------------
// 5. PREVIEW (first 50 rows)
// -------------------------------------------------------------
router.get('/jobs/:jobId/preview', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const reportPath = path.join(PROCESSED_ROOT, `user_${req.user.id}`, jobId, 'report.json');

    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, message: 'Job preview data not found.' });
    }

    const diskReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return res.json({
      success: true,
      sample_cleaned_data: diskReport.sample_cleaned_data || [],
      date_column: diskReport.date_column,
      target_column: diskReport.target_column,
      frequency: diskReport.frequency
    });
  } catch (err) {
    console.error('[Get Job Preview Error]', err);
    return res.status(500).json({ success: false, message: 'Could not fetch data preview.' });
  }
});

// -------------------------------------------------------------
// 6. DOWNLOAD CLEANED CSV
// -------------------------------------------------------------
router.get('/jobs/:jobId/download', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    const datasetRes = await db.query(
      `SELECT p.file_path, d.file_name
       FROM processed_datasets p
       JOIN uploaded_datasets d ON p.source_dataset_id = d.id
       WHERE p.job_id = $1 AND p.user_id = $2`,
      [jobId, req.user.id]
    );

    if (!datasetRes.rows || datasetRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cleaned dataset not found or access denied.' });
    }

    const record = datasetRes.rows[0];
    const absolutePath = path.resolve(__dirname, '..', '..', record.file_path);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ success: false, message: 'Cleaned file is missing from server storage.' });
    }

    const baseName = path.basename(record.file_name, path.extname(record.file_name));
    const downloadFilename = `cleaned_${baseName}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    const fileStream = fs.createReadStream(absolutePath);
    return fileStream.pipe(res);
  } catch (err) {
    console.error('[Download Cleaned Dataset Error]', err);
    return res.status(500).json({ success: false, message: 'Failed to download file.' });
  }
});

// -------------------------------------------------------------
// 7. USER'S PREPROCESSING JOB HISTORY
// -------------------------------------------------------------
router.get('/jobs', authenticateToken, async (req, res) => {
  try {
    const jobsRes = await db.query(
      `SELECT 
         j.id, j.dataset_id, j.status, j.created_at, j.started_at, j.finished_at, j.error_message,
         d.file_name as source_filename,
         p.rows_before, p.rows_after, p.quality_score_before, p.quality_score_after, p.readiness_score, p.frequency,
         p.date_column, p.target_column
       FROM processing_jobs j
       JOIN uploaded_datasets d ON j.dataset_id = d.id
       LEFT JOIN processed_datasets p ON j.id = p.job_id
       WHERE j.user_id = $1
       ORDER BY j.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    return res.json({
      success: true,
      jobs: jobsRes.rows
    });
  } catch (err) {
    console.error('[Get Job History Error]', err);
    return res.status(500).json({ success: false, message: 'Could not fetch job history.' });
  }
});

module.exports = router;
