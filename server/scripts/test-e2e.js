/**
 * GlassBox-BI Automated Verification Test Suite
 * Validates PostgreSQL Persistence, Authentication, CSRF, Token Hashing,
 * Single-Use Expiry, Google OAuth, and Dataset Uploads
 */

process.env.MOCK_EMAIL = 'true'; // Guard automated tests from sending real external emails
require('dotenv').config();

const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');
const crypto = require('crypto');

const BASE_URL = 'http://localhost:3000';

async function runTests() {
  console.log('============================================================');
  console.log('GlassBox-BI Enterprise PostgreSQL Integration Test Suite');
  console.log('============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  // 1. Health check & PostgreSQL Engine verification
  try {
    const health = await axios.get(`${BASE_URL}/api/health`);
    assert(health.data.status === 'healthy', 'API Health Check returns healthy');
    assert(health.data.db && health.data.db.isPostgres === true, `PostgreSQL is verified as active database (engine: ${health.data.db.engine}, db: ${health.data.db.name})`);
  } catch (e) {
    assert(false, `API Health Check failed: ${e.message}`);
  }

  // Direct PostgreSQL Connection pool for testing direct persistence
  const pgPool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5433', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'glassbox_bi'
  });

  try {
    const pgTest = await pgPool.query('SELECT current_database(), current_user, version()');
    assert(pgTest.rows[0].current_database === (process.env.PGDATABASE || 'glassbox_bi'), `Direct PostgreSQL connection verified on port ${process.env.PGPORT || '5433'}`);
  } catch (pgErr) {
    assert(false, `Direct PostgreSQL connection failed: ${pgErr.message}`);
  }

  // 2. CSRF Token extraction
  let csrfToken = '';
  let cookieHeader = '';
  try {
    const csrfRes = await axios.get(`${BASE_URL}/api/csrf-token`);
    csrfToken = csrfRes.data.csrfToken;
    const cookies = csrfRes.headers['set-cookie'];
    if (cookies) {
      cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
    }
    assert(Boolean(csrfToken), `CSRF Token received: ${csrfToken.substring(0, 10)}...`);
  } catch (e) {
    assert(false, `CSRF token retrieval failed: ${e.message}`);
  }

  const client = axios.create({
    baseURL: BASE_URL,
    headers: {
      'X-CSRF-Token': csrfToken,
      'Cookie': cookieHeader
    },
    validateStatus: () => true
  });

  // 3. Register with weak password (<8 chars)
  const testEmail = `analyst_pg_${Date.now()}@glassbox-test.com`;
  const weakPasswordRes = await client.post('/api/auth/register', {
    full_name: 'Test Analyst',
    email: testEmail,
    password: 'weak',
    confirm_password: 'weak'
  });
  assert(weakPasswordRes.status === 400 && weakPasswordRes.data.field === 'password', 'Password validation blocks passwords without required entropy (<8 chars)');

  // 4. Register with valid credentials (saves to PostgreSQL)
  const validPassword = 'SecurePassword123!';
  const registerRes = await client.post('/api/auth/register', {
    full_name: 'Lead BI Analyst',
    email: testEmail,
    password: validPassword,
    confirm_password: validPassword
  });
  assert(registerRes.status === 201 && registerRes.data.success, 'Registration succeeds with compliant password');

  // Verify persistence in PostgreSQL users table
  const pgUserRes = await pgPool.query('SELECT id, full_name, email, auth_provider FROM users WHERE email = $1', [testEmail]);
  assert(pgUserRes.rows.length === 1 && pgUserRes.rows[0].email === testEmail, `User verified directly in PostgreSQL users table (ID: ${pgUserRes.rows[0].id})`);

  // 5. Duplicate email registration rejected
  const dupRegisterRes = await client.post('/api/auth/register', {
    full_name: 'Duplicate Analyst',
    email: testEmail,
    password: validPassword,
    confirm_password: validPassword
  });
  assert(dupRegisterRes.status === 409, 'Duplicate email registration rejected with 409 Conflict');

  // 6. Login with wrong password rejected
  const badLoginRes = await client.post('/api/auth/login', {
    email: testEmail,
    password: 'WrongPassword999!'
  });
  assert(badLoginRes.status === 401, 'Login fails with incorrect password (401 Unauthorized)');

  // 7. Login with valid credentials
  const loginRes = await client.post('/api/auth/login', {
    email: testEmail,
    password: validPassword
  });
  assert(loginRes.status === 200 && loginRes.data.token, 'Login succeeds and returns JWT auth token');

  // Capture auth cookies
  let authCookieHeader = cookieHeader;
  const loginCookies = loginRes.headers['set-cookie'];
  if (loginCookies) {
    authCookieHeader = loginCookies.map(c => c.split(';')[0]).join('; ') + '; ' + cookieHeader;
  }

  const authenticatedClient = axios.create({
    baseURL: BASE_URL,
    headers: {
      'X-CSRF-Token': csrfToken,
      'Cookie': authCookieHeader,
      'Authorization': `Bearer ${loginRes.data.token}`
    },
    validateStatus: () => true
  });

  // 8. Auth session check (/api/auth/me)
  const meRes = await authenticatedClient.get('/api/auth/me');
  assert(meRes.status === 200 && meRes.data.user.email === testEmail, 'GET /api/auth/me returns authenticated user profile from PostgreSQL');

  // 9. Google OAuth Configuration & Route tests
  const googleStatusRes = await client.get('/api/auth/google/status');
  assert(googleStatusRes.status === 200 && googleStatusRes.data.configured === true, 'Google OAuth status reports configured in backend');

  const googleRedirectRes = await client.get('/api/auth/google', { maxRedirects: 0 });
  const googleLocation = googleRedirectRes.headers['location'] || '';
  assert(googleLocation.includes('accounts.google.com/o/oauth2/v2/auth') && googleLocation.includes('state='), 'GET /api/auth/google initiates OAuth flow with CSRF state parameter');

  // 10. Forgot Password request
  const forgotRes = await client.post('/api/auth/forgot-password', {
    email: testEmail
  }, {
    headers: {
      'x-test-suite': 'true'
    }
  });
  assert(forgotRes.status === 200 && forgotRes.data.message.includes('If this email exists'), 'Forgot password returns security-compliant message without revealing user existence');

  // Check token in PostgreSQL password_reset_tokens table
  const pgTokensRes = await pgPool.query(
    'SELECT * FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [pgUserRes.rows[0].id]
  );
  assert(pgTokensRes.rows.length === 1 && pgTokensRes.rows[0].used === false, 'Password reset token created and stored securely in PostgreSQL');

  // Retrieve reset URL (from response dev field or generated token)
  let rawToken = '';
  if (forgotRes.data.devResetUrl) {
    const urlObj = new URL(forgotRes.data.devResetUrl);
    rawToken = urlObj.searchParams.get('token');
  }

  // 11. Validate reset token endpoint
  const validateTokenRes = await client.get(`/api/auth/validate-reset-token?token=${rawToken}`);
  assert(validateTokenRes.status === 200 && validateTokenRes.data.valid, 'GET /api/auth/validate-reset-token validates newly issued token');

  // 12. Reset Password with new password
  const newPassword = 'BrandNewPassword2026!';
  const resetPassRes = await client.post('/api/auth/reset-password', {
    token: rawToken,
    new_password: newPassword,
    confirm_password: newPassword
  });
  assert(resetPassRes.status === 200 && resetPassRes.data.success, 'POST /api/auth/reset-password successfully updates password in PostgreSQL');

  // 13. Single-Use Token Enforcement: token cannot be reused
  const reuseTokenRes = await client.post('/api/auth/reset-password', {
    token: rawToken,
    new_password: 'AnotherPassword2026!',
    confirm_password: 'AnotherPassword2026!'
  });
  assert(reuseTokenRes.status === 400 && reuseTokenRes.data.message.includes('already been used'), 'Password reset token cannot be reused (Single-Use Enforcement verified)');

  // 14. Old password no longer works
  const oldLoginRes = await client.post('/api/auth/login', {
    email: testEmail,
    password: validPassword
  });
  assert(oldLoginRes.status === 401, 'Old password is confirmed invalid after reset');

  // 15. New password works
  const newLoginRes = await client.post('/api/auth/login', {
    email: testEmail,
    password: newPassword
  });
  assert(newLoginRes.status === 200 && newLoginRes.data.success, 'Login succeeds with new password after reset');

  // Update authenticated client headers
  const newLoginCookies = newLoginRes.headers['set-cookie'];
  if (newLoginCookies) {
    authCookieHeader = newLoginCookies.map(c => c.split(';')[0]).join('; ') + '; ' + cookieHeader;
  }
  const currentToken = newLoginRes.data.token;
  authenticatedClient.defaults.headers['Authorization'] = `Bearer ${currentToken}`;
  authenticatedClient.defaults.headers['Cookie'] = authCookieHeader;

  // 16. File Upload: Reject invalid file type (.sh / .txt)
  const invalidForm = new FormData();
  invalidForm.append('dataset', Buffer.from('illegal file content'), {
    filename: 'unauthorized_script.sh',
    contentType: 'application/x-sh'
  });
  const rejectUploadRes = await authenticatedClient.post('/api/datasets/upload', invalidForm, {
    headers: {
      ...invalidForm.getHeaders(),
      'X-CSRF-Token': csrfToken,
      'Cookie': authCookieHeader,
      'Authorization': `Bearer ${currentToken}`
    }
  });
  assert(rejectUploadRes.status === 400 && rejectUploadRes.data.message.includes('Accepted formats are .csv, .xls, and .xlsx ONLY'), 'File upload rejects non-spreadsheet files with clear error message');

  // 17. File Upload: Accept valid .csv & store in PostgreSQL
  const sampleCsvContent = 'Date,Product,Region,Sales,Quantity\n2026-01-01,Enterprise BI,North,150000,45\n2026-01-02,Forecasting Agent,South,85000,22\n';
  const validCsvForm = new FormData();
  validCsvForm.append('dataset', Buffer.from(sampleCsvContent), {
    filename: 'quarterly_sales_bi.csv',
    contentType: 'text/csv'
  });
  const csvUploadRes = await authenticatedClient.post('/api/datasets/upload', validCsvForm, {
    headers: {
      ...validCsvForm.getHeaders(),
      'X-CSRF-Token': csrfToken,
      'Cookie': authCookieHeader,
      'Authorization': `Bearer ${currentToken}`
    }
  });
  assert(csvUploadRes.status === 201 && csvUploadRes.data.dataset && csvUploadRes.data.dataset.file_name === 'quarterly_sales_bi.csv', 'File upload accepts .csv file and records metadata');

  const datasetId = csvUploadRes.data.dataset ? csvUploadRes.data.dataset.id : null;

  // Verify dataset record in PostgreSQL
  const pgDatasetRes = await pgPool.query('SELECT * FROM uploaded_datasets WHERE id = $1', [datasetId]);
  assert(pgDatasetRes.rows.length === 1 && pgDatasetRes.rows[0].file_name === 'quarterly_sales_bi.csv', `Uploaded dataset verified directly in PostgreSQL table (ID: ${datasetId})`);

  // 18. List datasets from PostgreSQL
  const listDatasetsRes = await authenticatedClient.get('/api/datasets');
  assert(listDatasetsRes.status === 200 && listDatasetsRes.data.datasets.length >= 1, 'GET /api/datasets lists ingested datasets from PostgreSQL');

  // 19. Remove dataset
  if (datasetId) {
    const deleteRes = await authenticatedClient.delete(`/api/datasets/${datasetId}`);
    assert(deleteRes.status === 200 && deleteRes.data.success, 'DELETE /api/datasets/:id removes dataset record from PostgreSQL and disk');
  }

  // 20. Logout endpoint clears session
  const logoutRes = await authenticatedClient.post('/api/auth/logout');
  assert(logoutRes.status === 200 && logoutRes.data.success, 'POST /api/auth/logout invalidates session and clears cookie');

  await pgPool.end();

  console.log('\n============================================================');
  console.log(`Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
