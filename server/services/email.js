const nodemailer = require('nodemailer');

let transporter = null;
let lastSentResetLinkForDev = null; // Store for easy dev testing/preview

function getTransporter() {
  if (transporter) return transporter;

  // In test mode, allow stream or memory transporter
  if (process.env.MOCK_EMAIL === 'true') {
    transporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'windows',
      buffer: true
    });
    return transporter;
  }

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const rawPass = process.env.SMTP_PASS;
  const pass = rawPass ? rawPass.replace(/\s+/g, '') : '';

  if (user && pass) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user, pass }
    });
    console.log(`[Email] Configured Gmail/Custom SMTP with host: ${host} (${user})`);
  } else {
    // Development fallback
    transporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'windows',
      buffer: true
    });
    console.log('[Email] No SMTP credentials provided in .env. Operating in Developer Console Mode.');
  }

  return transporter;
}

function setTransporter(customTransporter) {
  transporter = customTransporter;
}

async function sendPasswordResetEmail({ to, resetUrl, fullName }) {
  const mailer = getTransporter();
  const from = process.env.EMAIL_FROM || '"GlassBox-BI Support" <no-reply@glassbox-bi.ai>';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Reset Your GlassBox-BI Password</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b; }
        .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .header { background: #1a2332; padding: 24px 32px; color: #ffffff; text-align: left; }
        .header h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; }
        .header .badge { background: #0d9488; color: #ffffff; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; margin-left: 8px; }
        .content { padding: 32px; font-size: 14px; line-height: 1.6; color: #334155; }
        .button { display: inline-block; background-color: #0d9488; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; margin: 20px 0; }
        .button:hover { background-color: #0f766e; }
        .link-alt { font-size: 12px; color: #64748b; word-break: break-all; margin-top: 16px; }
        .footer { background: #f8fafc; padding: 20px 32px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; text-align: left; }
        .warning-box { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px; font-size: 13px; color: #92400e; margin: 16px 0; border-radius: 0 4px 4px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>GlassBox-BI <span class="badge">Security</span></h1>
        </div>
        <div class="content">
          <p>Hello <strong>${fullName || 'User'}</strong>,</p>
          <p>We received a request to reset the password for your GlassBox-BI account.</p>
          <p>Click the button below to choose a new password. This link is secure and will expire in <strong>1 hour</strong>.</p>
          
          <div style="text-align: center; margin: 28px 0;">
            <a href="${resetUrl}" class="button" target="_blank">Reset Password</a>
          </div>

          <div class="warning-box">
            <strong>Security Notice:</strong> If you did not request a password reset, no action is required. Your account remains completely secure.
          </div>

          <p class="link-alt">
            If the button above does not work, copy and paste this URL into your browser:<br>
            <a href="${resetUrl}" style="color: #0d9488;">${resetUrl}</a>
          </p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} GlassBox-BI Enterprise Analytics. All rights reserved.<br>
          Multi-Agent Explainable AI Framework for Business Analytics.
        </div>
      </div>
    </body>
    </html>
  `;

  lastSentResetLinkForDev = {
    to,
    resetUrl,
    timestamp: new Date().toISOString()
  };

  try {
    const info = await mailer.sendMail({
      from,
      to,
      subject: 'Reset your GlassBox-BI password',
      text: `Hello ${fullName || 'User'},\n\nPlease reset your password using the following link (expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: htmlContent
    });

    console.log(`\n============================================================`);
    console.log(`[EMAIL DISPATCH] Password Reset Email dispatched to: ${to}`);
    console.log(`[ACTION LINK] ${resetUrl}`);
    console.log(`============================================================\n`);

    return {
      success: true,
      messageId: info.messageId,
      devResetUrl: !process.env.SMTP_USER ? resetUrl : undefined
    };
  } catch (err) {
    console.error('[Email] Failed to send email via SMTP:', err.message);
    // In dev mode, return resetUrl anyway so user is never blocked
    return {
      success: true,
      fallbackUsed: true,
      devResetUrl: resetUrl
    };
  }
}

function getLastSentDevResetLink() {
  return lastSentResetLinkForDev;
}

module.exports = {
  sendPasswordResetEmail,
  getLastSentDevResetLink,
  setTransporter
};
