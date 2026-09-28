/**
 * End-to-End Test Suite for GlassBox-BI Forecasting Agent
 * Tests:
 * 1. Health checks (Express :3000, Forecasting Agent :8002)
 * 2. User registration and authentication (with CSRF)
 * 3. Preprocessing pipeline integration (producing a clean processed_dataset)
 * 4. GET /api/agents/forecasting/datasets
 * 5. POST /api/agents/forecasting/precheck (validation, eligibility rules)
 * 6. Ownership security check (cross-user access blocked)
 * 7. POST /api/agents/forecasting/run (async job execution)
 * 8. Status polling and completion verification
 * 9. GET /api/agents/forecasting/jobs/:jobId/report (winner, leaderboard, audit log)
 * 10. GET /api/agents/forecasting/jobs/:jobId/forecast (history, holdout, intervals)
 * 11. GET /api/agents/forecasting/jobs/:jobId/download (forecast.csv download)
 * 12. Verification of model artifacts & metadata saved for XAI Agent
 * 13. GET /api/agents/forecasting/jobs (history listing)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000';
const FORECASTING_URL = process.env.FORECASTING_AGENT_URL || 'http://127.0.0.1:8002';

const ts = Date.now();
const userA = {
  full_name: 'Forecasting Lead A',
  email: `fc_analyst_a_${ts}@glassbox.ai`,
  password: 'TestPassword123!',
  confirm_password: 'TestPassword123!'
};

const userB = {
  full_name: 'Forecasting Analyst B',
  email: `fc_analyst_b_${ts}@glassbox.ai`,
  password: 'TestPassword123!',
  confirm_password: 'TestPassword123!'
};

let cookiesA = '';
let csrfTokenA = '';
let cookiesB = '';
let csrfTokenB = '';
let userAId = null;

let uploadedDatasetId = null;
let processedDatasetId = null;
let forecastJobId = null;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`\x1b[32m[PASS] ${msg}\x1b[0m`);
    passed++;
  } else {
    console.error(`\x1b[31m[FAIL] ${msg}\x1b[0m`);
    failed++;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('============================================================');
  console.log('  Running Forecasting Agent End-to-End Tests');
  console.log('============================================================\n');

  try {
    // 1. Health Checks
    const expHealth = await axios.get(`${BASE_URL}/api/health`);
    assert(expHealth.data.status === 'healthy', 'Express API health endpoint is healthy');
    assert(expHealth.data.db.isPostgres === true, 'PostgreSQL is the active database');

    const fcHealth = await axios.get(`${FORECASTING_URL}/health`);
    assert(fcHealth.data.status === 'healthy', 'Forecasting Python service is healthy on port 8002');

    // 2. Setup User A (Register & Login with CSRF)
    const csrfResA = await axios.get(`${BASE_URL}/api/csrf-token`);
    csrfTokenA = csrfResA.data.csrfToken;
    cookiesA = (csrfResA.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const regResA = await axios.post(`${BASE_URL}/api/auth/register`, userA, {
      headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
    });
    assert(regResA.data.success === true, 'User A registered successfully');

    const loginResA = await axios.post(`${BASE_URL}/api/auth/login`, {
      email: userA.email,
      password: userA.password
    }, {
      headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
    });
    assert(loginResA.data.success === true, 'User A logged in successfully');
    if (loginResA.headers['set-cookie']) {
      cookiesA = loginResA.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') + '; ' + cookiesA;
    }

    const meResA = await axios.get(`${BASE_URL}/api/auth/me`, {
      headers: { 'Cookie': cookiesA }
    });
    userAId = meResA.data.user.id;
    assert(userAId !== undefined, `User A retrieved with ID: ${userAId}`);

    // Setup User B (Register & Login with CSRF for isolation tests)
    const csrfResB = await axios.get(`${BASE_URL}/api/csrf-token`);
    csrfTokenB = csrfResB.data.csrfToken;
    cookiesB = (csrfResB.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const regResB = await axios.post(`${BASE_URL}/api/auth/register`, userB, {
      headers: { 'X-CSRF-Token': csrfTokenB, 'Cookie': cookiesB }
    });
    assert(regResB.data.success === true, 'User B registered successfully');

    const loginResB = await axios.post(`${BASE_URL}/api/auth/login`, {
      email: userB.email,
      password: userB.password
    }, {
      headers: { 'X-CSRF-Token': csrfTokenB, 'Cookie': cookiesB }
    });
    assert(loginResB.data.success === true, 'User B logged in successfully');
    if (loginResB.headers['set-cookie']) {
      cookiesB = loginResB.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') + '; ' + cookiesB;
    }

    // 3. Upload Sample Dataset for User A
    const sampleFilePath = path.join(__dirname, '..', '..', 'samples', 'monthly_sales_trend_seasonal.csv');
    assert(fs.existsSync(sampleFilePath), 'Sample monthly sales dataset exists on disk');

    const form = new FormData();
    form.append('dataset', fs.createReadStream(sampleFilePath));

    const uploadRes = await axios.post(`${BASE_URL}/api/datasets/upload`, form, {
      headers: {
        ...form.getHeaders(),
        'X-CSRF-Token': csrfTokenA,
        'Cookie': cookiesA
      }
    });
    assert(uploadRes.status === 201 && uploadRes.data.success === true, 'Dataset uploaded successfully');
    uploadedDatasetId = uploadRes.data.dataset.id;
    assert(uploadedDatasetId !== undefined, `Uploaded dataset ID: ${uploadedDatasetId}`);

    // 4. Preprocess Dataset to produce processed_datasets record
    const prepRunRes = await axios.post(`${BASE_URL}/api/agents/preprocessing/run`, {
      datasetId: uploadedDatasetId,
      config: {
        date_column: 'date',
        target_column: 'sales',
        frequency: 'M',
        duplicate_aggregation: 'sum',
        outlier_action: 'cap',
        outlier_method: 'iqr',
        missing_threshold: 60
      }
    }, {
      headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
    });
    assert(prepRunRes.status === 202 && prepRunRes.data.success === true, 'Preprocessing job scheduled');
    const prepJobId = prepRunRes.data.jobId;

    let prepCompleted = false;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const poll = await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs/${prepJobId}`, {
        headers: { 'Cookie': cookiesA }
      });
      if (poll.data.job && poll.data.job.status === 'completed') {
        prepCompleted = true;
        break;
      }
    }
    assert(prepCompleted === true, 'Preprocessing job completed and produced cleaned dataset');

    // 5. GET /api/agents/forecasting/datasets
    const fcDatasetsRes = await axios.get(`${BASE_URL}/api/agents/forecasting/datasets`, {
      headers: { 'Cookie': cookiesA }
    });
    assert(fcDatasetsRes.data.success === true && fcDatasetsRes.data.datasets.length > 0, 'Forecasting agent lists user processed datasets');
    const processedRecord = fcDatasetsRes.data.datasets[0];
    processedDatasetId = processedRecord.id;
    assert(processedRecord.target_column === 'sales', `Processed dataset target column is '${processedRecord.target_column}'`);
    assert(processedRecord.date_column === 'date', `Processed dataset date column is '${processedRecord.date_column}'`);

    // 6. POST /api/agents/forecasting/precheck
    const precheckRes = await axios.post(`${BASE_URL}/api/agents/forecasting/precheck`, {
      processedDatasetId
    }, {
      headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
    });
    assert(precheckRes.data.success === true, 'Pre-check completed successfully');
    assert(precheckRes.data.validation.is_valid === true, 'Time-series validation passed');
    assert(precheckRes.data.total_rows === 60, `Pre-check counted 60 observations`);
    assert(precheckRes.data.eligibility['Seasonal Naive'].eligible === true, 'Seasonal Naive is eligible');
    assert(precheckRes.data.eligibility['ETS (Exponential Smoothing)'].eligible === true, 'ETS is eligible');
    assert(precheckRes.data.eligibility['ARIMA / SARIMA'].eligible === true, 'ARIMA is eligible');
    assert(precheckRes.data.eligibility['LightGBM'].eligible === true, 'LightGBM is eligible');
    assert(precheckRes.data.eligibility['Prophet'].eligible === true, 'Prophet is eligible');

    // 7. Security: User B cannot precheck User A's dataset
    try {
      await axios.post(`${BASE_URL}/api/agents/forecasting/precheck`, {
        processedDatasetId
      }, {
        headers: { 'X-CSRF-Token': csrfTokenB, 'Cookie': cookiesB }
      });
      assert(false, 'User B should NOT be able to precheck User A dataset');
    } catch (err) {
      assert(err.response.status === 404, 'User B was rejected with 404 for accessing User A dataset');
    }

    // 8. POST /api/agents/forecasting/run
    const runRes = await axios.post(`${BASE_URL}/api/agents/forecasting/run`, {
      processedDatasetId,
      config: {
        horizon: 6,
        metric: 'rmse',
        holdoutPercent: 0.20,
        confidenceLevels: [0.80, 0.95],
        models: [
          'Seasonal Naive',
          'ETS (Exponential Smoothing)',
          'ARIMA / SARIMA',
          'Prophet',
          'LightGBM',
          'Theta'
        ]
      }
    }, {
      headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
    });
    assert(runRes.status === 202 && runRes.data.success === true, 'Forecasting job scheduled (HTTP 202)');
    forecastJobId = runRes.data.jobId;
    assert(forecastJobId !== undefined, `Forecast Job ID created: ${forecastJobId}`);

    // 9. Poll until forecasting job is completed
    let forecastCompleted = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const poll = await axios.get(`${BASE_URL}/api/agents/forecasting/jobs/${forecastJobId}`, {
        headers: { 'Cookie': cookiesA }
      });
      if (poll.data.job && poll.data.job.status === 'completed') {
        forecastCompleted = true;
        break;
      }
      if (poll.data.job && poll.data.job.status === 'failed') {
        console.error('Job failed with:', poll.data.job.error_message);
        break;
      }
    }
    assert(forecastCompleted === true, `Forecasting job ${forecastJobId} finished successfully`);

    // 10. GET /api/agents/forecasting/jobs/:jobId/report
    const reportRes = await axios.get(`${BASE_URL}/api/agents/forecasting/jobs/${forecastJobId}/report`, {
      headers: { 'Cookie': cookiesA }
    });
    assert(reportRes.data.success === true, 'Forecast report retrieved successfully');
    assert(reportRes.data.job.winner_model !== null, `Winning model chosen: ${reportRes.data.job.winner_model}`);
    assert(reportRes.data.leaderboard.length === 6, `Leaderboard contains all 6 models evaluated`);
    assert(reportRes.data.audit_actions.length >= 6, `Audit trail contains ${reportRes.data.audit_actions.length} recorded events`);

    const winnerEntry = reportRes.data.leaderboard.find(r => r.rank === 1);
    assert(winnerEntry !== undefined, `Rank 1 winner model exists on leaderboard: ${winnerEntry ? winnerEntry.model_name : 'none'}`);
    assert(winnerEntry.rmse > 0, `Winner RMSE is positive: ${winnerEntry.rmse}`);

    // 11. GET /api/agents/forecasting/jobs/:jobId/forecast
    const fcDataRes = await axios.get(`${BASE_URL}/api/agents/forecasting/jobs/${forecastJobId}/forecast`, {
      headers: { 'Cookie': cookiesA }
    });
    assert(fcDataRes.data.success === true, 'Forecast visualization data retrieved');
    assert(fcDataRes.data.history.length === 60, `History contains all 60 historical time points`);
    assert(fcDataRes.data.forecast.length === 6, `Future forecast contains requested 6 periods`);
    assert(fcDataRes.data.forecast[0].lower_80 !== null, 'Confidence intervals (lower_80) computed');
    assert(fcDataRes.data.forecast[0].upper_95 !== null, 'Confidence intervals (upper_95) computed');
    assert(fcDataRes.data.holdout.length === 6, 'Holdout comparisons contain 6 evaluation points');

    // 12. GET /api/agents/forecasting/jobs/:jobId/download
    const dlRes = await axios.get(`${BASE_URL}/api/agents/forecasting/jobs/${forecastJobId}/download`, {
      headers: { 'Cookie': cookiesA }
    });
    assert(dlRes.status === 200, 'Forecast CSV download returns HTTP 200');
    assert(typeof dlRes.data === 'string' && dlRes.data.includes('forecast') && dlRes.data.includes('lower_80') && dlRes.data.includes('upper_95'), 'Forecast CSV contains header with intervals');

    // 13. Model Artifacts & Feature Metadata Verification for XAI Agent
    const modelArtifactPath = path.join(__dirname, '..', '..', 'models', String(userAId), forecastJobId, 'model.joblib');
    const metadataPath = path.join(__dirname, '..', '..', 'models', String(userAId), forecastJobId, 'metadata.json');
    assert(fs.existsSync(modelArtifactPath), 'Trained model artifact (.joblib) saved for future XAI Agent');
    assert(fs.existsSync(metadataPath), 'Feature metadata (.json) saved for future XAI Agent');

    const metaContent = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert(metaContent.model_name === reportRes.data.job.winner_model, 'Model metadata records winning model name');
    assert(metaContent.target_column === 'sales', 'Model metadata records target column');

    // 14. GET /api/agents/forecasting/jobs (History listing)
    const historyRes = await axios.get(`${BASE_URL}/api/agents/forecasting/jobs`, {
      headers: { 'Cookie': cookiesA }
    });
    assert(historyRes.data.success === true && historyRes.data.jobs.length > 0, 'User job history contains completed forecasting job');

    // 15. Cross-User Access Security Check: User B cannot access User A's job
    try {
      await axios.get(`${BASE_URL}/api/agents/forecasting/jobs/${forecastJobId}/report`, {
        headers: { 'Cookie': cookiesB }
      });
      assert(false, 'User B should NOT be able to access User A job report');
    } catch (err) {
      assert(err.response.status === 404, 'User B rejected with 404 trying to access User A forecast report');
    }

  } catch (err) {
    console.error('[TEST SUITE ERROR]', err.response ? err.response.data : err.message);
    failed++;
  } finally {
    console.log('============================================================');
    console.log(`Forecasting Agent Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('============================================================');
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
