const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const FORECASTING_URL = process.env.FORECASTING_AGENT_URL || 'http://127.0.0.1:8002';
const FORECASTS_ROOT = path.join(__dirname, '..', '..', 'forecasts');
const MODELS_ROOT = path.join(__dirname, '..', '..', 'models');

if (!fs.existsSync(FORECASTS_ROOT)) {
  fs.mkdirSync(FORECASTS_ROOT, { recursive: true });
}
if (!fs.existsSync(MODELS_ROOT)) {
  fs.mkdirSync(MODELS_ROOT, { recursive: true });
}

// Rate Limiter: Max 20 forecast runs per 15 minutes per IP
const runForecastLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    message: 'Too many forecasting requests from this IP. Please try again after 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Helper to call internal Python Forecasting microservice
 */
async function callForecastingService(endpoint, body) {
  const url = `${FORECASTING_URL}${endpoint}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      let errMsg = `Forecasting service responded with status ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData.detail || errMsg;
      } catch (e) {}
      throw new Error(errMsg);
    }

    return await response.json();
  } catch (err) {
    if (err.cause && (err.cause.code === 'ECONNREFUSED' || err.cause.code === 'ENOTFOUND')) {
      throw new Error(`Forecasting Agent service is unreachable at ${FORECASTING_URL}. Please ensure the Python service is running.`);
    }
    throw err;
  }
}

/**
 * Verify processed dataset ownership and existence
 */
async function getOwnedProcessedDataset(processedDatasetId, userId) {
  const res = await db.query(
    `SELECT pd.*, ud.file_name AS source_file_name
     FROM processed_datasets pd
     JOIN uploaded_datasets ud ON pd.source_dataset_id = ud.id
     WHERE pd.id = $1 AND pd.user_id = $2`,
    [processedDatasetId, userId]
  );

  if (!res.rows || res.rows.length === 0) {
    return null;
  }

  const record = res.rows[0];
  const absolutePath = path.isAbsolute(record.file_path)
    ? record.file_path
    : path.resolve(__dirname, '..', '..', record.file_path);

  if (!fs.existsSync(absolutePath)) {
    throw new Error('Processed dataset file is missing from server storage.');
  }

  return { dataset: record, absolutePath };
}

function readHandoffJson(directory, filename) {
  try {
    const file = path.join(directory, filename);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch (_) {
    return {};
  }
}

// -------------------------------------------------------------
// 1. LIST COMPLETED PROCESSED DATASETS FOR FORECASTING
// -------------------------------------------------------------
router.get('/datasets', authenticateToken, async (req, res) => {
  try {
    const queryRes = await db.query(
      `SELECT pd.id, pd.source_dataset_id, pd.file_path, pd.rows_before, pd.rows_after,
              pd.columns_before, pd.columns_after, pd.date_column, pd.target_column,
              pd.frequency, pd.quality_score_after, pd.readiness_score, pd.created_at,
              ud.file_name AS source_file_name
       FROM processed_datasets pd
       JOIN uploaded_datasets ud ON pd.source_dataset_id = ud.id
       WHERE pd.user_id = $1
       ORDER BY pd.created_at DESC`,
      [req.user.id]
    );

    return res.json({
      success: true,
      datasets: queryRes.rows || []
    });
  } catch (err) {
    console.error('[Forecasting] Error listing datasets:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve processed datasets.' });
  }
});

// -------------------------------------------------------------
// 2. PRE-CHECK DATASET (Steps 1–3)
// -------------------------------------------------------------
router.post('/precheck', authenticateToken, async (req, res) => {
  try {
    const { processedDatasetId } = req.body;
    if (!processedDatasetId) {
      return res.status(400).json({ success: false, message: 'Processed dataset ID is required.' });
    }

    const owned = await getOwnedProcessedDataset(processedDatasetId, req.user.id);
    if (!owned) {
      return res.status(404).json({ success: false, message: 'Processed dataset not found or access denied.' });
    }

    const { dataset, absolutePath } = owned;

    const precheckData = await callForecastingService('/precheck', {
      file_path: absolutePath,
      date_column: dataset.date_column,
      target_column: dataset.target_column,
      frequency: dataset.frequency || 'D'
    });

    return res.json({
      success: precheckData.success !== false,
      dataset_id: dataset.id,
      source_file_name: dataset.source_file_name,
      date_column: dataset.date_column,
      target_column: dataset.target_column,
      frequency: dataset.frequency,
      readiness_score: dataset.readiness_score,
      validation: precheckData.validation,
      suggested_horizon: precheckData.suggested_horizon,
      seasonal_period: precheckData.seasonal_period,
      total_rows: precheckData.total_rows,
      eligibility: precheckData.eligibility,
      actions: precheckData.actions
    });
  } catch (err) {
    console.error('[Forecasting] Error running precheck:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to inspect dataset for forecasting.' });
  }
});

// -------------------------------------------------------------
// 3. RUN FORECASTING JOB (Steps 1–10 Asynchronous)
// -------------------------------------------------------------
router.post('/run', authenticateToken, runForecastLimiter, async (req, res) => {
  try {
    const { processedDatasetId, config } = req.body;
    if (!processedDatasetId) {
      return res.status(400).json({ success: false, message: 'Processed dataset ID is required.' });
    }

    const owned = await getOwnedProcessedDataset(processedDatasetId, req.user.id);
    if (!owned) {
      return res.status(404).json({ success: false, message: 'Processed dataset not found or access denied.' });
    }

    const { dataset, absolutePath } = owned;
    const cfg = config || {};

    // Server-side validation of config values
    const horizon = parseInt(cfg.horizon || '12', 10);
    if (isNaN(horizon) || horizon < 1 || horizon > 365) {
      return res.status(400).json({ success: false, message: 'Forecast horizon must be an integer between 1 and 365.' });
    }

    const allowedMetrics = ['rmse', 'mae', 'smape'];
    const rankingMetric = (cfg.metric || 'rmse').toLowerCase();
    if (!allowedMetrics.includes(rankingMetric)) {
      return res.status(400).json({ success: false, message: `Invalid ranking metric. Must be one of: ${allowedMetrics.join(', ')}` });
    }

    const allowedModels = [
      'Seasonal Naive',
      'ETS (Exponential Smoothing)',
      'ARIMA / SARIMA',
      'Prophet',
      'LightGBM',
      'Theta'
    ];
    let selectedModels = Array.isArray(cfg.models) && cfg.models.length > 0 ? cfg.models : allowedModels;
    selectedModels = selectedModels.filter(m => allowedModels.includes(m));
    if (selectedModels.length === 0) {
      selectedModels = allowedModels;
    }

    const holdoutPercent = Math.min(0.35, Math.max(0.10, parseFloat(cfg.holdoutPercent || '0.20')));
    const confidenceLevels = Array.isArray(cfg.confidenceLevels) ? cfg.confidenceLevels : [0.80, 0.95];

    // Create Job in Database
    const jobId = crypto.randomUUID();
    const outputDir = path.join(FORECASTS_ROOT, String(req.user.id), jobId);
    const modelsDir = path.join(MODELS_ROOT, String(req.user.id), jobId);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(modelsDir, { recursive: true });

    await db.query(
      `INSERT INTO forecast_jobs (id, user_id, processed_dataset_id, status, config_json, horizon, selected_metric, started_at)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, CURRENT_TIMESTAMP)`,
      [
        jobId,
        req.user.id,
        dataset.id,
        JSON.stringify({
          horizon,
          metric: rankingMetric,
          models: selectedModels,
          holdoutPercent,
          confidenceLevels,
          source_dataset_id: dataset.source_dataset_id
        }),
        horizon,
        rankingMetric
      ]
    );

    // Asynchronous Execution via Python Service
    setImmediate(async () => {
      try {
        await db.query(`UPDATE forecast_jobs SET status = 'validating' WHERE id = $1`, [jobId]);

        await db.query(`UPDATE forecast_jobs SET status = 'training' WHERE id = $1`, [jobId]);

        const result = await callForecastingService('/forecast', {
          file_path: absolutePath,
          date_column: dataset.date_column,
          target_column: dataset.target_column,
          frequency: dataset.frequency || 'D',
          user_id: String(req.user.id),
          job_id: jobId,
          horizon: horizon,
          selected_models: selectedModels,
          ranking_metric: rankingMetric,
          holdout_percent: holdoutPercent,
          confidence_levels: confidenceLevels,
          output_dir: outputDir,
          models_dir: modelsDir,
          evaluation_file_path: fs.existsSync(path.join(path.dirname(absolutePath), 'evaluation_source.csv')) ? path.join(path.dirname(absolutePath), 'evaluation_source.csv') : null,
          preprocessing_recipe: readHandoffJson(path.dirname(absolutePath), 'report.json').transformation_recipe || null,
          preprocessing_contract: readHandoffJson(path.dirname(absolutePath), 'data_contract.json')
        });

        if (!result.success) {
          throw new Error(result.error || 'Forecasting pipeline failed.');
        }

        await db.query(`UPDATE forecast_jobs SET status = 'evaluating' WHERE id = $1`, [jobId]);

        const clampMetric = (val) => {
          if (val === null || val === undefined || isNaN(val)) return null;
          const num = Number(val);
          if (!isFinite(num)) return null;
          if (num > 999999999.9999) return 999999999.9999;
          if (num < -999999999.9999) return -999999999.9999;
          return num;
        };

        const clampPoint = (val) => {
          if (val === null || val === undefined || isNaN(val)) return null;
          const num = Number(val);
          if (!isFinite(num)) return null;
          if (num > 999999999999.9999) return 999999999999.9999;
          if (num < -999999999999.9999) return -999999999999.9999;
          return num;
        };

        // Insert model evaluation leaderboard
        const leaderboard = result.model_leaderboard || [];
        for (const m of leaderboard) {
          await db.query(
            `INSERT INTO forecast_model_results (
               job_id, model_name, status, skip_reason, mae, rmse, mape, smape, mase,
               beats_baseline, rank, hyperparameters_json, train_seconds
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              jobId,
              m.model_name,
              m.status,
              m.skip_reason || null,
              clampMetric(m.mae),
              clampMetric(m.rmse),
              clampMetric(m.mape),
              clampMetric(m.smape),
              clampMetric(m.mase),
              m.beats_baseline ? true : false,
              m.rank || 999,
              JSON.stringify(m.hyperparameters || {}),
              clampMetric(m.train_seconds) || 0.0
            ]
          );
        }

        // Insert future forecast points
        const points = result.forecast_points || [];
        for (const pt of points) {
          await db.query(
            `INSERT INTO forecast_points (
               job_id, forecast_date, forecast_value, lower_80, upper_80, lower_95, upper_95
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              jobId,
              pt.date,
              clampPoint(pt.forecast),
              clampPoint(pt.lower_80),
              clampPoint(pt.upper_80),
              clampPoint(pt.lower_95),
              clampPoint(pt.upper_95)
            ]
          );
        }

        // Insert audit action log
        const actions = result.audit_actions || [];
        for (const act of actions) {
          await db.query(
            `INSERT INTO forecast_actions (
               job_id, step_order, step_name, model_name, action, description
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              jobId,
              act.step_order,
              act.step_name,
              act.model_name || null,
              act.action,
              act.description
            ]
          );
        }

        // Mark job completed
        await db.query(
          `UPDATE forecast_jobs
           SET status = 'completed',
               winner_model = $1,
               selected_metric = $2,
               finished_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [result.winner_model, rankingMetric, jobId]
        );

        console.log(`[Forecasting] Job ${jobId} completed successfully. Winner: ${result.winner_model}`);
      } catch (pipelineErr) {
        console.error(`[Forecasting] Job ${jobId} execution error:`, pipelineErr);
        await db.query(
          `UPDATE forecast_jobs
           SET status = 'failed',
               error_message = $1,
               finished_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [pipelineErr.message || 'Unknown forecasting error', jobId]
        );
      }
    });

    return res.status(202).json({
      success: true,
      jobId,
      message: 'Forecasting job accepted and processing in background.'
    });
  } catch (err) {
    console.error('[Forecasting] Error launching job:', err);
    return res.status(500).json({ success: false, message: 'Failed to initiate forecasting job.' });
  }
});

// -------------------------------------------------------------
// 4. POLL JOB STATUS
// -------------------------------------------------------------
router.get('/jobs/:jobId', authenticateToken, async (req, res) => {
  try {
    const queryRes = await db.query(
      `SELECT id, user_id, processed_dataset_id, status, horizon, selected_metric,
              winner_model, error_message, started_at, finished_at, created_at
       FROM forecast_jobs
       WHERE id = $1 AND user_id = $2`,
      [req.params.jobId, req.user.id]
    );

    if (!queryRes.rows || queryRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Forecast job not found or access denied.' });
    }

    return res.json({
      success: true,
      job: queryRes.rows[0]
    });
  } catch (err) {
    console.error('[Forecasting] Error querying job status:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve job status.' });
  }
});

// -------------------------------------------------------------
// 5. GET FULL JOB REPORT & LEADERBOARD
// -------------------------------------------------------------
router.get('/jobs/:jobId/report', authenticateToken, async (req, res) => {
  try {
    const jobRes = await db.query(
      `SELECT fj.*, pd.date_column, pd.target_column, pd.frequency, ud.file_name AS source_file_name
       FROM forecast_jobs fj
       JOIN processed_datasets pd ON fj.processed_dataset_id = pd.id
       JOIN uploaded_datasets ud ON pd.source_dataset_id = ud.id
       WHERE fj.id = $1 AND fj.user_id = $2`,
      [req.params.jobId, req.user.id]
    );

    if (!jobRes.rows || jobRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Forecast job not found or access denied.' });
    }

    const job = jobRes.rows[0];

    const resultsRes = await db.query(
      `SELECT * FROM forecast_model_results
       WHERE job_id = $1
       ORDER BY rank ASC`,
      [job.id]
    );

    const actionsRes = await db.query(
      `SELECT * FROM forecast_actions
       WHERE job_id = $1
       ORDER BY step_order ASC`,
      [job.id]
    );

    // Read report.json if available on disk for rich split & feature details
    let diskReport = null;
    const reportPath = path.join(FORECASTS_ROOT, String(req.user.id), job.id, 'report.json');
    if (fs.existsSync(reportPath)) {
      try {
        diskReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch (e) {}
    }

    return res.json({
      success: true,
      job,
      leaderboard: resultsRes.rows || [],
      audit_actions: actionsRes.rows || [],
      disk_report: diskReport
    });
  } catch (err) {
    console.error('[Forecasting] Error retrieving job report:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve job report.' });
  }
});

// -------------------------------------------------------------
// 6. GET FORECAST CHART DATA (History + Holdout + Future)
// -------------------------------------------------------------
router.get('/jobs/:jobId/forecast', authenticateToken, async (req, res) => {
  try {
    const jobRes = await db.query(
      `SELECT fj.id, fj.processed_dataset_id, fj.winner_model, fj.horizon,
              pd.file_path, pd.date_column, pd.target_column, pd.frequency
       FROM forecast_jobs fj
       JOIN processed_datasets pd ON fj.processed_dataset_id = pd.id
       WHERE fj.id = $1 AND fj.user_id = $2 AND fj.status = 'completed'`,
      [req.params.jobId, req.user.id]
    );

    if (!jobRes.rows || jobRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Completed forecast job not found.' });
    }

    const job = jobRes.rows[0];

    // 1. Future points from database
    const pointsRes = await db.query(
      `SELECT forecast_date, forecast_value, lower_80, upper_80, lower_95, upper_95
       FROM forecast_points
       WHERE job_id = $1
       ORDER BY id ASC`,
      [job.id]
    );

    // 2. Read historical observations from dataset file
    const absoluteDatasetPath = path.isAbsolute(job.file_path)
      ? job.file_path
      : path.resolve(__dirname, '..', '..', job.file_path);

    let history = [];
    if (fs.existsSync(absoluteDatasetPath)) {
      const csvContent = fs.readFileSync(absoluteDatasetPath, 'utf8');
      const lines = csvContent.trim().split('\n');
      if (lines.length > 1) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const dateIdx = headers.indexOf(job.date_column);
        const targetIdx = headers.indexOf(job.target_column);

        if (dateIdx !== -1 && targetIdx !== -1) {
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length > Math.max(dateIdx, targetIdx)) {
              history.push({
                date: cols[dateIdx],
                value: parseFloat(cols[targetIdx]) || 0.0
              });
            }
          }
        }
      }
    }

    // 3. Holdout predictions from holdout_predictions.csv if present
    let holdoutData = [];
    const holdoutPath = path.join(FORECASTS_ROOT, String(req.user.id), job.id, 'holdout_predictions.csv');
    if (fs.existsSync(holdoutPath)) {
      const hContent = fs.readFileSync(holdoutPath, 'utf8');
      const hLines = hContent.trim().split('\n');
      if (hLines.length > 1) {
        const hHeaders = hLines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        for (let i = 1; i < hLines.length; i++) {
          const cols = hLines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
          const rowObj = {};
          hHeaders.forEach((h, idx) => {
            rowObj[h] = idx === 0 ? cols[idx] : (parseFloat(cols[idx]) || null);
          });
          holdoutData.push(rowObj);
        }
      }
    }

    return res.json({
      success: true,
      job_id: job.id,
      winner_model: job.winner_model,
      frequency: job.frequency,
      history,
      holdout: holdoutData,
      forecast: pointsRes.rows || []
    });
  } catch (err) {
    console.error('[Forecasting] Error retrieving forecast chart data:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve forecast data.' });
  }
});

// -------------------------------------------------------------
// 7. DOWNLOAD FORECAST CSV
// -------------------------------------------------------------
router.get('/jobs/:jobId/download', authenticateToken, async (req, res) => {
  try {
    const jobRes = await db.query(
      `SELECT id FROM forecast_jobs
       WHERE id = $1 AND user_id = $2 AND status = 'completed'`,
      [req.params.jobId, req.user.id]
    );

    if (!jobRes.rows || jobRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Completed forecast job not found.' });
    }

    const csvPath = path.resolve(FORECASTS_ROOT, String(req.user.id), req.params.jobId, 'forecast.csv');

    // Prevent path traversal
    if (!csvPath.startsWith(path.resolve(FORECASTS_ROOT))) {
      return res.status(403).json({ success: false, message: 'Invalid file path request.' });
    }

    if (!fs.existsSync(csvPath)) {
      return res.status(404).json({ success: false, message: 'Forecast CSV file is missing from server storage.' });
    }

    return res.download(csvPath, `forecast_${req.params.jobId.substring(0, 8)}.csv`);
  } catch (err) {
    console.error('[Forecasting] Error downloading forecast CSV:', err);
    return res.status(500).json({ success: false, message: 'Failed to download forecast CSV.' });
  }
});

// -------------------------------------------------------------
// 8. LIST USER'S FORECAST JOBS HISTORY
// -------------------------------------------------------------
router.get('/jobs', authenticateToken, async (req, res) => {
  try {
    const queryRes = await db.query(
      `SELECT fj.id, fj.status, fj.horizon, fj.selected_metric, fj.winner_model,
              fj.error_message, fj.started_at, fj.finished_at, fj.created_at,
              pd.date_column, pd.target_column, pd.frequency,
              ud.file_name AS source_file_name,
              fm.rmse, fm.mae, fm.smape
       FROM forecast_jobs fj
       JOIN processed_datasets pd ON fj.processed_dataset_id = pd.id
       JOIN uploaded_datasets ud ON pd.source_dataset_id = ud.id
       LEFT JOIN forecast_model_results fm ON fj.id = fm.job_id AND fm.rank = 1
       WHERE fj.user_id = $1
       ORDER BY fj.created_at DESC`,
      [req.user.id]
    );

    return res.json({
      success: true,
      jobs: queryRes.rows || []
    });
  } catch (err) {
    console.error('[Forecasting] Error listing jobs history:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve forecast jobs.' });
  }
});

module.exports = router;
