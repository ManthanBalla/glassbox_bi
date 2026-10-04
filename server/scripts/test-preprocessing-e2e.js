/**
 * End-to-end Integration Test for GlassBox-BI Data Preprocessing Agent
 * Tests dataset upload, profiling, pipeline execution, explainability audit log,
 * forecast readiness evaluation, report retrieval, and user ownership isolation.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
let userA = { email: `analyst_agent_${Date.now()}@glassbox.ai`, password: 'TestPassword123!', confirm_password: 'TestPassword123!', full_name: 'Agent Tester' };
let userB = { email: `other_analyst_${Date.now()}@glassbox.ai`, password: 'TestPassword123!', confirm_password: 'TestPassword123!', full_name: 'Other Analyst' };

let cookiesA = '';
let csrfTokenA = '';
let cookiesB = '';
let csrfTokenB = '';

let datasetIdA = null;
let jobIdA = null;

function assert(cond, msg) {
  if (!cond) {
    console.error(`\x1b[31m[FAIL] ${msg}\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32m[PASS] ${msg}\x1b[0m`);
}

async function runTests() {
  console.log('============================================================');
  console.log('  Running Data Preprocessing Agent End-to-End Tests');
  console.log('============================================================\n');

  // 1. Health Check
  const healthRes = await axios.get(`${BASE_URL}/api/health`);
  assert(healthRes.data.status === 'healthy', 'System health endpoint returns healthy');
  assert(healthRes.data.db.isPostgres === true, 'PostgreSQL is the active database');

  // 2. Register & Login User A
  const csrfResA = await axios.get(`${BASE_URL}/api/csrf-token`);
  csrfTokenA = csrfResA.data.csrfToken;
  const cookieHeadersA = csrfResA.headers['set-cookie'] || [];
  cookiesA = cookieHeadersA.map(c => c.split(';')[0]).join('; ');

  const regResA = await axios.post(`${BASE_URL}/api/auth/register`, userA, {
    headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
  });
  assert(regResA.data.success === true, 'User A registered successfully');

  const loginResA = await axios.post(`${BASE_URL}/api/auth/login`, { email: userA.email, password: userA.password }, {
    headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
  });
  assert(loginResA.data.success === true, 'User A logged in successfully');
  if (loginResA.headers['set-cookie']) {
    cookiesA = loginResA.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') + '; ' + cookiesA;
  }

  // 3. Register & Login User B (for isolation tests)
  const csrfResB = await axios.get(`${BASE_URL}/api/csrf-token`);
  csrfTokenB = csrfResB.data.csrfToken;
  cookiesB = (csrfResB.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  const regResB = await axios.post(`${BASE_URL}/api/auth/register`, userB, {
    headers: { 'X-CSRF-Token': csrfTokenB, 'Cookie': cookiesB }
  });
  assert(regResB.data.success === true, 'User B registered successfully');

  const loginResB = await axios.post(`${BASE_URL}/api/auth/login`, { email: userB.email, password: userB.password }, {
    headers: { 'X-CSRF-Token': csrfTokenB, 'Cookie': cookiesB }
  });
  assert(loginResB.data.success === true, 'User B logged in successfully');
  if (loginResB.headers['set-cookie']) {
    cookiesB = loginResB.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') + '; ' + cookiesB;
  }

  // 4. Upload messy_ecommerce.csv as User A
  const sampleFilePath = path.join(__dirname, '..', '..', 'samples', 'messy_ecommerce.csv');
  assert(fs.existsSync(sampleFilePath), 'Sample file messy_ecommerce.csv exists');

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
  datasetIdA = uploadRes.data.dataset.id;
  assert(datasetIdA !== undefined, `Dataset assigned ID: ${datasetIdA}`);

  // 5. Test Profile Dataset (Steps 1–4)
  const profileRes = await axios.post(`${BASE_URL}/api/agents/preprocessing/profile`, {
    datasetId: datasetIdA
  }, {
    headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
  });
  assert(profileRes.data.success === true, 'Profile endpoint returned success');
  assert(profileRes.data.profile.total_rows > 30, `Profile total rows: ${profileRes.data.profile.total_rows}`);
  assert(profileRes.data.detected_date_column === 'order_date', `Correctly auto-detected date column: ${profileRes.data.detected_date_column}`);
  assert(profileRes.data.suggested_target_column === 'revenue', `Correctly suggested target column: ${profileRes.data.suggested_target_column}`);
  assert(profileRes.data.profile.quality_score > 0, `Baseline Quality Score computed: ${profileRes.data.profile.quality_score}/100`);

  // 6. Test User Ownership Isolation on Profile (User B trying to profile User A's dataset)
  try {
    await axios.post(`${BASE_URL}/api/agents/preprocessing/profile`, {
      datasetId: datasetIdA
    }, {
      headers: { 'X-CSRF-Token': csrfTokenB, 'Cookie': cookiesB }
    });
    assert(false, 'User B should NOT be able to profile User A dataset');
  } catch (err) {
    assert(err.response.status === 404, 'User B was rejected with 404 for accessing User A dataset');
  }

  // 7. Dispatch Full Preprocessing Pipeline Run (Steps 1–10)
  const runRes = await axios.post(`${BASE_URL}/api/agents/preprocessing/run`, {
    datasetId: datasetIdA,
    config: {
      date_column: 'order_date',
      target_column: 'revenue',
      frequency: 'D',
      duplicate_aggregation: 'sum',
      outlier_action: 'cap',
      outlier_method: 'iqr',
      missing_threshold: 60
    }
  }, {
    headers: { 'X-CSRF-Token': csrfTokenA, 'Cookie': cookiesA }
  });
  assert(runRes.status === 202 && runRes.data.success === true, 'Preprocessing job scheduled (HTTP 202)');
  jobIdA = runRes.data.jobId;
  assert(jobIdA !== undefined, `Job ID created: ${jobIdA}`);

  // 8. Poll for Job Completion
  let jobCompleted = false;
  let lastProgressStage = null;
  let attempts = 0;
  while (!jobCompleted && attempts < 20) {
    await new Promise(r => setTimeout(r, 1000));
    const statusRes = await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs/${jobIdA}`, {
      headers: { 'Cookie': cookiesA }
    });
    lastProgressStage = statusRes.data.job.progress_stage;
    if (statusRes.data.job.status === 'completed') {
      jobCompleted = true;
      break;
    } else if (statusRes.data.job.status === 'failed') {
      console.error('Job failed with error:', statusRes.data.job.error_message);
      break;
    }
    attempts++;
  }
  assert(jobCompleted === true, `Job ${jobIdA} completed successfully within timeout`);
  assert(lastProgressStage === 'complete', 'Job status exposes completed pipeline progress');

  // 9. Fetch Full Report
  const reportRes = await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs/${jobIdA}/report`, {
    headers: { 'Cookie': cookiesA }
  });
  assert(reportRes.data.success === true, 'Full report retrieved');
  const report = reportRes.data;
  assert(report.quality.after >= report.quality.before, `Quality improved from ${report.quality.before} to ${report.quality.after}`);
  assert(report.readiness.score >= 70, `Forecast Readiness Score: ${report.readiness.score}/100 (${report.readiness.overall_status})`);
  assert(Array.isArray(report.audit_log) && report.audit_log.length >= 6, `Explainability audit log has ${report.audit_log.length} actions`);
  assert(Array.isArray(report.readiness.checklist) && report.readiness.checklist.length === 5, 'Readiness checklist has all 5 verification dimensions');
  assert(report.data_contract?.date_column === 'order_date' && report.data_contract?.target_column === 'revenue', 'Data contract contains the selected series');
  assert(typeof report.forecastability?.score === 'number' && report.processing_confidence?.level, 'Forecastability and processing confidence returned');
  assert(typeof report.time_health?.missing_periods === 'number' && Array.isArray(report.outlier_events), 'Time health and anomaly details returned');
  const handoffDir = path.resolve(__dirname, '..', '..', path.dirname(report.dataset.file_path));
  for (const filename of ['schema.json', 'data_quality.json', 'forecast_readiness.json', 'forecastability.json', 'transformation_log.json', 'data_contract.json', 'preprocessing_metadata.json', 'evaluation_source.csv']) {
    assert(fs.existsSync(path.join(handoffDir, filename)), `Handoff file saved: ${filename}`);
  }
  const reportDownload = await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs/${jobIdA}/report/download`, { headers: { 'Cookie': cookiesA } });
  assert(reportDownload.status === 200 && reportDownload.data.data_contract?.target_column === 'revenue', 'Structured report downloaded');

  // Verify an audit log entry format
  const firstAction = report.audit_log[0];
  assert(firstAction.step_name !== undefined && firstAction.description.length > 5, `Audit log entry verified: "${firstAction.description}"`);

  // 10. Fetch Cleaned Preview (first 50 rows)
  const previewRes = await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs/${jobIdA}/preview`, {
    headers: { 'Cookie': cookiesA }
  });
  assert(previewRes.data.success === true, 'Data preview retrieved');
  assert(Array.isArray(previewRes.data.sample_cleaned_data) && previewRes.data.sample_cleaned_data.length > 0, `Preview has ${previewRes.data.sample_cleaned_data.length} rows`);

  // 11. Download Cleaned CSV
  const downloadRes = await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs/${jobIdA}/download`, {
    headers: { 'Cookie': cookiesA },
    responseType: 'text'
  });
  assert(downloadRes.status === 200, 'Cleaned CSV downloaded successfully');
  assert(downloadRes.data.includes('order_date') && downloadRes.data.includes('revenue'), 'CSV contains clean headers: order_date, revenue');
  assert(!downloadRes.data.includes('$'), 'Cleaned CSV has all currency symbols stripped');

  // 12. Fetch User Job History
  const historyRes = await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs`, {
    headers: { 'Cookie': cookiesA }
  });
  assert(historyRes.data.success === true, 'Job history retrieved');
  assert(historyRes.data.jobs.some(j => j.id === jobIdA), 'Current job appears in user job history');

  // 13. Test Ownership Isolation on Job Report (User B trying to access User A's job)
  try {
    await axios.get(`${BASE_URL}/api/agents/preprocessing/jobs/${jobIdA}/report`, {
      headers: { 'Cookie': cookiesB }
    });
    assert(false, 'User B should NOT be able to view User A job report');
  } catch (err) {
    assert(err.response.status === 404, 'User B was rejected with 404 for accessing User A job report');
  }

  console.log('\n============================================================');
  console.log('  ALL PREPROCESSING AGENT INTEGRATION TESTS PASSED (13/13)');
  console.log('============================================================\n');
}

runTests().catch(err => {
  console.error('\n[FATAL TEST FAILURE]', err.response ? err.response.data : err.message);
  process.exit(1);
});
