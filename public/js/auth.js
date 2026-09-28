/**
 * GlassBox-BI Authentication Logic
 * Supports Login, Register, Forgot Password, Reset Password, and Google OAuth
 */

// Helper to display alert banners
function showAlert(containerId, message, type = 'error') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const iconSvg = type === 'success' 
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;

  container.innerHTML = `
    <div class="alert alert-${type}">
      ${iconSvg}
      <div>${message}</div>
    </div>
  `;
}

function clearAlert(containerId) {
  const container = document.getElementById(containerId);
  if (container) container.innerHTML = '';
}

// Clear individual input error states
function clearInputErrors(form) {
  const inputs = form.querySelectorAll('.form-control');
  inputs.forEach(input => {
    input.classList.remove('is-invalid');
    const errSpan = form.querySelector(`#${input.id}-error`);
    if (errSpan) errSpan.textContent = '';
  });
}

function setFieldError(form, fieldId, errorText) {
  const input = form.querySelector(`#${fieldId}`);
  if (input) {
    input.classList.add('is-invalid');
    const errSpan = form.querySelector(`#${fieldId}-error`);
    if (errSpan) {
      errSpan.textContent = errorText;
    }
  }
}

// -------------------------------------------------------------
// 1. LOGIN PAGE INITIALIZATION
// -------------------------------------------------------------
function initLoginPage() {
  const form = document.getElementById('login-form');
  if (!form) return;

  // Check URL query parameters for registration or oauth messages
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('registered')) {
    showAlert('alert-container', 'Account registered successfully! Please log in.', 'success');
  }
  if (urlParams.has('password_reset')) {
    showAlert('alert-container', 'Password updated successfully! Please log in with your new password.', 'success');
  }
  if (urlParams.has('oauth_error')) {
    showAlert('alert-container', decodeURIComponent(urlParams.get('oauth_error')), 'error');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert('alert-container');
    clearInputErrors(form);

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const submitBtn = document.getElementById('submit-btn');

    let hasError = false;
    if (!email) {
      setFieldError(form, 'email', 'Email address is required.');
      hasError = true;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(form, 'email', 'Please enter a valid email address.');
      hasError = true;
    }

    if (!password) {
      setFieldError(form, 'password', 'Password is required.');
      hasError = true;
    }

    if (hasError) return;

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span> Signing in...`;

    try {
      const res = await api.post('/api/auth/login', { email, password });

      if (res.success) {
        window.location.href = '/dashboard.html';
      } else {
        if (res.field) {
          setFieldError(form, res.field, res.message);
        } else {
          showAlert('alert-container', res.message || 'Login failed. Please verify credentials.');
        }
      }
    } catch (err) {
      showAlert('alert-container', 'An unexpected error occurred. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `Login`;
    }
  });

  setupGoogleOAuthButton();
}

// -------------------------------------------------------------
// 2. REGISTER PAGE INITIALIZATION
// -------------------------------------------------------------
function initRegisterPage() {
  const form = document.getElementById('register-form');
  if (!form) return;

  const passwordInput = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirm_password');

  // Interactive Live Password Criteria Checklist
  const ruleLength = document.getElementById('rule-length');
  const ruleNumber = document.getElementById('rule-number');
  const ruleSpecial = document.getElementById('rule-special');
  const ruleMatch = document.getElementById('rule-match');

  function updatePasswordRules() {
    const val = passwordInput.value;
    const confirmVal = confirmPasswordInput.value;

    const isLengthValid = val.length >= 8;
    const isNumberValid = /\d/.test(val);
    const isSpecialValid = /[!@#$%^&*(),.?":{}|<>\-_=+]/.test(val);
    const isMatchValid = val.length > 0 && val === confirmVal;

    updateRuleElement(ruleLength, isLengthValid);
    updateRuleElement(ruleNumber, isNumberValid);
    updateRuleElement(ruleSpecial, isSpecialValid);
    if (ruleMatch) {
      updateRuleElement(ruleMatch, isMatchValid);
    }
  }

  function updateRuleElement(el, isValid) {
    if (!el) return;
    if (isValid) {
      el.classList.add('valid');
      el.querySelector('.rule-icon').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else {
      el.classList.remove('valid');
      el.querySelector('.rule-icon').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>`;
    }
  }

  passwordInput.addEventListener('input', updatePasswordRules);
  confirmPasswordInput.addEventListener('input', updatePasswordRules);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert('alert-container');
    clearInputErrors(form);

    const fullName = document.getElementById('full_name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const submitBtn = document.getElementById('submit-btn');

    let hasError = false;
    if (!fullName) {
      setFieldError(form, 'full_name', 'Full name is required.');
      hasError = true;
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(form, 'email', 'Please enter a valid email address.');
      hasError = true;
    }

    if (password.length < 8) {
      setFieldError(form, 'password', 'Password must be at least 8 characters long.');
      hasError = true;
    } else if (!/\d/.test(password)) {
      setFieldError(form, 'password', 'Password must contain at least one number.');
      hasError = true;
    } else if (!/[!@#$%^&*(),.?":{}|<>\-_=+]/.test(password)) {
      setFieldError(form, 'password', 'Password must contain at least one special character.');
      hasError = true;
    }

    if (password !== confirmPassword) {
      setFieldError(form, 'confirm_password', 'Passwords do not match.');
      hasError = true;
    }

    if (hasError) return;

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span> Creating Account...`;

    try {
      const res = await api.post('/api/auth/register', {
        full_name: fullName,
        email,
        password,
        confirm_password: confirmPassword
      });

      if (res.success) {
        window.location.href = '/login.html?registered=true';
      } else {
        if (res.field) {
          setFieldError(form, res.field, res.message);
        } else {
          showAlert('alert-container', res.message || 'Registration failed.');
        }
      }
    } catch (err) {
      showAlert('alert-container', 'Network error. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `Register`;
    }
  });

  setupGoogleOAuthButton();
}

// -------------------------------------------------------------
// 3. FORGOT PASSWORD INITIALIZATION
// -------------------------------------------------------------
function initForgotPasswordPage() {
  const form = document.getElementById('forgot-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert('alert-container');
    clearInputErrors(form);

    const email = document.getElementById('email').value.trim();
    const submitBtn = document.getElementById('submit-btn');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(form, 'email', 'Please enter a valid email address.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span> Sending Reset Link...`;

    try {
      const res = await api.post('/api/auth/forgot-password', { email });

      // Always show standard security confirmation
      showAlert('alert-container', res.message || 'If this email exists, a password reset link has been sent.', 'success');

      // If in developer test preview, render direct clickable test link
      if (res.devResetUrl) {
        const devBox = document.getElementById('dev-preview-box');
        if (devBox) {
          devBox.style.display = 'block';
          devBox.innerHTML = `
            <div style="background: #f8fafc; border: 1px dashed #0d9488; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 13px;">
              <strong style="color: #0d9488; display: block; margin-bottom: 4px;">Developer Preview / Test Mode:</strong>
              <p style="margin: 0 0 8px 0; color: #475569;">SMTP keys are not configured. Click the generated reset link below to test the reset password flow directly:</p>
              <a href="${res.devResetUrl}" class="btn btn-sm btn-primary" style="word-break: break-all;">Open Reset Password Page &rarr;</a>
            </div>
          `;
        }
      }

      form.reset();
    } catch (err) {
      showAlert('alert-container', 'An unexpected error occurred. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `Send Reset Link`;
    }
  });
}

// -------------------------------------------------------------
// 4. RESET PASSWORD INITIALIZATION
// -------------------------------------------------------------
async function initResetPasswordPage() {
  const form = document.getElementById('reset-password-form');
  if (!form) return;

  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  if (!token) {
    showAlert('alert-container', 'No password reset token was provided in the URL. Please request a new link.');
    document.getElementById('form-fields-container').style.display = 'none';
    return;
  }

  // Validate token with server on load
  try {
    const checkRes = await api.get(`/api/auth/validate-reset-token?token=${encodeURIComponent(token)}`);
    if (!checkRes.valid) {
      showAlert('alert-container', checkRes.message || 'This reset link is invalid or has expired.');
      document.getElementById('form-fields-container').style.display = 'none';
      return;
    }

    if (checkRes.email) {
      const emailHint = document.getElementById('reset-user-email');
      if (emailHint) emailHint.textContent = `Resetting password for: ${checkRes.email}`;
    }
  } catch (err) {
    showAlert('alert-container', 'Failed to validate reset link.');
    return;
  }

  // Live password checklist
  const passwordInput = document.getElementById('new_password');
  const confirmPasswordInput = document.getElementById('confirm_password');
  const ruleLength = document.getElementById('rule-length');
  const ruleNumber = document.getElementById('rule-number');
  const ruleSpecial = document.getElementById('rule-special');

  function updateResetRules() {
    const val = passwordInput.value;
    updateRule(ruleLength, val.length >= 8);
    updateRule(ruleNumber, /\d/.test(val));
    updateRule(ruleSpecial, /[!@#$%^&*(),.?":{}|<>\-_=+]/.test(val));
  }

  function updateRule(el, isValid) {
    if (!el) return;
    if (isValid) {
      el.classList.add('valid');
      el.querySelector('.rule-icon').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else {
      el.classList.remove('valid');
      el.querySelector('.rule-icon').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>`;
    }
  }

  passwordInput.addEventListener('input', updateResetRules);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert('alert-container');
    clearInputErrors(form);

    const newPassword = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const submitBtn = document.getElementById('submit-btn');

    let hasError = false;
    if (newPassword.length < 8 || !/\d/.test(newPassword) || !/[!@#$%^&*(),.?":{}|<>\-_=+]/.test(newPassword)) {
      setFieldError(form, 'new_password', 'Password does not meet the security requirements.');
      hasError = true;
    }

    if (newPassword !== confirmPassword) {
      setFieldError(form, 'confirm_password', 'Passwords do not match.');
      hasError = true;
    }

    if (hasError) return;

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span> Updating Password...`;

    try {
      const res = await api.post('/api/auth/reset-password', {
        token,
        new_password: newPassword,
        confirm_password: confirmPassword
      });

      if (res.success) {
        window.location.href = '/login.html?password_reset=true';
      } else {
        showAlert('alert-container', res.message || 'Password reset failed.');
      }
    } catch (err) {
      showAlert('alert-container', 'Error resetting password. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `Set New Password`;
    }
  });
}

// -------------------------------------------------------------
// 5. GOOGLE OAUTH MODAL & FLOW HELPER
// -------------------------------------------------------------
function setupGoogleOAuthButton() {
  const googleBtn = document.getElementById('btn-google-oauth');
  if (!googleBtn) return;

  googleBtn.addEventListener('click', async () => {
    try {
      const statusRes = await api.get('/api/auth/google/status');
      if (statusRes.configured) {
        // Direct to official Google OAuth 2.0 endpoint
        window.location.href = '/api/auth/google';
      } else {
        // Show Google OAuth Setup Guidance Modal with instant test option
        openOAuthGuideModal();
      }
    } catch (err) {
      window.location.href = '/api/auth/google';
    }
  });
}

function openOAuthGuideModal() {
  let modal = document.getElementById('oauth-guide-modal');
  if (!modal) {
    const modalHtml = `
      <div id="oauth-guide-modal" class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <h3 style="font-size: 16px; margin: 0; display: flex; align-items: center; gap: 8px;">
              <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
              Google OAuth 2.0 Integration
            </h3>
            <button class="btn-sm btn-secondary" onclick="closeOAuthGuideModal()" style="border:none; cursor:pointer;">&times;</button>
          </div>
          <div class="modal-body">
            <p style="margin-bottom: 12px; font-size: 13px; color: #334155;">
              The official Google OAuth 2.0 flow is fully coded in the backend. To connect to your real Google Cloud Project:
            </p>
            <ol style="font-size: 12px; color: #475569; padding-left: 20px; line-height: 1.6; margin-bottom: 16px;">
              <li>Go to <strong>Google Cloud Console &rarr; Credentials</strong></li>
              <li>Create an <strong>OAuth 2.0 Client ID</strong> (Web Application)</li>
              <li>Add authorized redirect URI: <code style="background:#e2e8f0; padding:2px 4px; border-radius:4px;">http://localhost:3000/api/auth/google/callback</code></li>
              <li>Add <code style="background:#e2e8f0; padding:2px 4px; border-radius:4px;">GOOGLE_CLIENT_ID</code> and <code style="background:#e2e8f0; padding:2px 4px; border-radius:4px;">GOOGLE_CLIENT_SECRET</code> to your <code style="background:#e2e8f0; padding:2px 4px; border-radius:4px;">.env</code> file</li>
            </ol>
            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 12px; font-size: 13px; color: #1e40af;">
              <strong>Developer Testing Ready:</strong> You can click the button below to test the full Google OAuth session lifecycle right now with a verified demo profile.
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeOAuthGuideModal()">Cancel</button>
            <button class="btn btn-primary" id="btn-run-dev-google-login">Continue with Demo Google Account</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    modal = document.getElementById('oauth-guide-modal');

    document.getElementById('btn-run-dev-google-login').addEventListener('click', async () => {
      try {
        const devLoginRes = await api.post('/api/auth/google/dev-preview');
        if (devLoginRes.success) {
          window.location.href = '/dashboard.html';
        }
      } catch (err) {
        alert('Demo Google Login failed.');
      }
    });
  }

  modal.classList.add('active');
}

function closeOAuthGuideModal() {
  const modal = document.getElementById('oauth-guide-modal');
  if (modal) modal.classList.remove('active');
}

window.closeOAuthGuideModal = closeOAuthGuideModal;
window.initLoginPage = initLoginPage;
window.initRegisterPage = initRegisterPage;
window.initForgotPasswordPage = initForgotPasswordPage;
window.initResetPasswordPage = initResetPasswordPage;
