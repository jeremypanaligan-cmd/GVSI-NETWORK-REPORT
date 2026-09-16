#!/usr/bin/env python3
"""Redesign login interface: split-screen layout, floating labels, micro-interactions."""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ============================================================
# 1. NEW LOGIN HTML (replaces the old login section)
# ============================================================
OLD_LOGIN_HTML = '''<!-- ==================== LOGIN SCREEN ==================== -->
<div id="loginOverlay" class="login-overlay">
  <div class="login-card">
    <div class="login-brand">
      <span class="brand-gallop" style="font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 700; font-size: 22px; letter-spacing: 3px; color: var(--dark-charcoal);">GALLOPVISION</span>
    </div>
    <div class="login-subtitle">Network Operations Dashboard</div>
    <form class="login-form" id="loginForm" onsubmit="return handleLogin(event)">
      <div class="login-input-group">
        <label for="loginUsername">Username</label>
        <input type="text" id="loginUsername" placeholder="Enter username" autocomplete="username" required>
      </div>
      <div class="login-input-group">
        <label for="loginPassword">Password</label>
        <div style="position: relative;">
          <input type="password" id="loginPassword" placeholder="Enter password" autocomplete="current-password" required style="padding-right: 40px; width: 100%;">
          <button type="button" onclick="togglePasswordVisibility()" id="togglePwdBtn" style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; padding: 4px; color: var(--text-muted); display: flex; align-items: center; justify-content: center;">
            <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg id="eyeOffIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </button>
        </div>
      </div>
      <div class="login-error" id="loginError"></div>
      <label class="remember-me-label">
        <input type="checkbox" id="rememberMe"> Remember me
      </label>
      <button type="submit" class="login-btn" id="loginBtn" aria-live="polite" aria-busy="false">
        <span class="login-btn-spinner" id="loginBtnSpinner" aria-hidden="true"></span>
        <span id="loginBtnText">SIGN IN</span>
      </button>
      <div class="login-progress" id="loginProgress" role="status" aria-live="polite" aria-hidden="true"></div>
    </form>
    <div class="login-footer">GVSI NetPulse v3.9.5</div>
  </div>
</div>'''

NEW_LOGIN_HTML = '''<!-- ==================== LOGIN SCREEN (v3.10.0 - Modern Redesign) ==================== -->
<div id="loginOverlay" class="login-overlay">
  <div class="login-container">
    <!-- Left Panel: Brand Showcase -->
    <div class="login-brand-panel">
      <div class="brand-content">
        <div class="brand-logo">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <circle cx="24" cy="24" r="22" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
            <path d="M16 24L22 30L32 18" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h1 class="brand-name">GALLOPVISION</h1>
        <p class="brand-tagline">Network Operations Dashboard</p>
        <div class="brand-features">
          <div class="feature-item">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            <span>Real-time monitoring</span>
          </div>
          <div class="feature-item">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span>Incident management</span>
          </div>
          <div class="feature-item">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span>24/7 availability</span>
          </div>
        </div>
      </div>
      <div class="brand-footer">
        <span>Secure - Reliable - Fast</span>
      </div>
    </div>

    <!-- Right Panel: Login Form -->
    <div class="login-form-panel">
      <div class="form-wrapper">
        <div class="form-header">
          <h2>Welcome back</h2>
          <p>Sign in to access your dashboard</p>
        </div>

        <form class="login-form" id="loginForm" onsubmit="return handleLogin(event)" novalidate>
          <!-- Username Field (Floating Label) -->
          <div class="input-group floating">
            <input type="text" id="loginUsername" name="username" autocomplete="username" required aria-label="Username" placeholder=" ">
            <label for="loginUsername">Username</label>
            <div class="input-highlight"></div>
          </div>

          <!-- Password Field (Floating Label + Toggle) -->
          <div class="input-group floating">
            <input type="password" id="loginPassword" name="password" autocomplete="current-password" required aria-label="Password" placeholder=" " style="padding-right: 44px;">
            <label for="loginPassword">Password</label>
            <div class="input-highlight"></div>
            <button type="button" class="password-toggle" id="togglePwdBtn" aria-label="Toggle password visibility" onclick="togglePasswordVisibility()">
              <svg id="eyeIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg id="eyeOffIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>

          <!-- Error Message -->
          <div class="login-error" id="loginError" role="alert" aria-live="assertive"></div>

          <!-- Remember Me + Forgot Password -->
          <div class="form-options">
            <label class="remember-me">
              <input type="checkbox" id="rememberMe">
              <span class="checkmark"></span>
              <span>Remember me</span>
            </label>
            <a href="#" class="forgot-link" onclick="return false;">Forgot password?</a>
          </div>

          <!-- Submit Button -->
          <button type="submit" class="login-btn" id="loginBtn" aria-live="polite" aria-busy="false">
            <span class="btn-content">
              <span id="loginBtnText">Sign In</span>
              <svg class="btn-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </span>
            <span class="login-btn-spinner" id="loginBtnSpinner" aria-hidden="true" hidden></span>
          </button>

          <!-- Loading Progress -->
          <div class="login-progress" id="loginProgress" role="status" aria-live="polite" aria-hidden="true"></div>
        </form>

        <!-- Footer -->
        <div class="login-footer">
          <span>GVSI NetPulse v3.10.0</span>
          <span class="footer-dot">|</span>
          <span>Secured connection</span>
        </div>
      </div>
    </div>
  </div>
</div>'''

# ============================================================
# 2. NEW LOGIN CSS (replaces the old login styles)
# ============================================================
OLD_LOGIN_CSS = '''.login-overlay {
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  background: linear-gradient(135deg, #0d8a80 0%, #085f58 50%, #064e3b 100%);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
  visibility: visible;
  transition: opacity 0.4s ease, visibility 0.4s ease;
}

.login-overlay.hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.login-card {
  background: var(--card-bg);
  border-radius: 16px;
  padding: 32px 24px;
  width: 100%;
  max-width: 360px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
  text-align: center;
}

.login-brand {
  margin-bottom: 24px;
}

.login-brand .brand-gallop {
  font-size: 22px;
  letter-spacing: 3px;
  display: block;
  margin-bottom: 4px;
}

.login-brand .brand-converge {
  font-size: 13px;
}

.login-subtitle {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 24px;
  font-weight: 600;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-input-group {
  position: relative;
  text-align: left;
}

.login-input-group label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.login-input-group input {
  width: 100%;
  padding: 10px 12px;
  border: 2px solid var(--border-color);
  border-radius: 8px;
  font-size: 14px;
  background: var(--light-bg);
  color: var(--dark-charcoal);
  outline: none;
  transition: border-color 0.2s ease;
}

.login-input-group input:focus {
  border-color: var(--primary-teal);
}

.login-btn {
  width: 100%;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 12px;
  border: none;
  border-radius: 8px;
  background: var(--primary-teal);
  color: #ffffff;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  letter-spacing: 0.5px;
  transition: background 0.2s ease, transform 0.1s ease;
  margin-top: 4px;
}

.login-btn:hover {
  background: var(--primary-dark);
}

.login-btn:active {
  transform: scale(0.98);
}

.login-btn:disabled {
  opacity: 0.78;
  cursor: not-allowed;
}

.login-btn.is-loading {
  background: var(--primary-dark);
  cursor: wait;
}

.login-btn-spinner {
  width: 16px;
  height: 16px;
  display: inline-block;
  border: 2px solid rgba(255, 255, 255, 0.38);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: loginSpinner 0.75s linear infinite;
}

.login-btn-spinner[hidden] {
  display: none;
}

@keyframes loginSpinner {
  to { transform: rotate(360deg); }
}

.login-progress {
  min-height: 16px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

@media (prefers-reduced-motion: reduce) {
  .login-btn-spinner { animation: none; }
}

.login-error {
  font-size: 12px;
  color: var(--badge-red-text);
  font-weight: 600;
  min-height: 18px;
  margin-top: 4px;
}

.login-footer {
  margin-top: 20px;
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.3px;
}

/* Remember Me Label */
.remember-me-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  margin-top: -4px;
}

.remember-me-label input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--primary-teal);
  cursor: pointer;
}'''

NEW_LOGIN_CSS = '''/* ================================================================
   LOGIN SCREEN v3.10.0 - Modern Redesign
   Split-screen layout, floating labels, micro-interactions
   ================================================================ */

/* --- Overlay --- */
.login-overlay {
  position: fixed;
  inset: 0;
  background: #0b1220;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
  visibility: visible;
  transition: opacity 0.4s ease, visibility 0.4s ease;
}

.login-overlay.hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

/* --- Container (split-screen) --- */
.login-container {
  display: flex;
  width: 100%;
  max-width: 960px;
  min-height: 560px;
  background: var(--card-bg);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 25px 80px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05);
  animation: loginSlideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes loginSlideUp {
  from { opacity: 0; transform: translateY(24px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* --- Left Panel: Brand Showcase --- */
.login-brand-panel {
  flex: 1;
  background: linear-gradient(135deg, #0d8a80 0%, #085f58 60%, #064e3b 100%);
  padding: 48px 40px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  position: relative;
  overflow: hidden;
}

.login-brand-panel::before {
  content: '';
  position: absolute;
  top: -50%;
  right: -50%;
  width: 100%;
  height: 100%;
  background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%);
  pointer-events: none;
}

.brand-content {
  position: relative;
  z-index: 1;
}

.brand-logo {
  margin-bottom: 32px;
}

.brand-name {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 28px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 4px;
  margin: 0 0 8px;
}

.brand-tagline {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 1px;
  margin: 0 0 40px;
  font-weight: 500;
}

.brand-features {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  font-weight: 500;
}

.feature-item svg {
  opacity: 0.7;
  flex-shrink: 0;
}

.brand-footer {
  position: relative;
  z-index: 1;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 1px;
}

/* --- Right Panel: Login Form --- */
.login-form-panel {
  flex: 1;
  padding: 48px 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--card-bg);
}

.form-wrapper {
  width: 100%;
  max-width: 320px;
}

.form-header {
  margin-bottom: 32px;
}

.form-header h2 {
  font-size: 24px;
  font-weight: 700;
  color: var(--dark-charcoal);
  margin: 0 0 8px;
}

.form-header p {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0;
}

/* --- Form --- */
.login-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* --- Floating Label Input --- */
.input-group.floating {
  position: relative;
}

.input-group.floating input {
  width: 100%;
  padding: 16px 14px 8px;
  border: 1.5px solid var(--border-color);
  border-radius: 10px;
  font-size: 15px;
  background: var(--light-bg);
  color: var(--dark-charcoal);
  outline: none;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.input-group.floating input:focus {
  border-color: var(--primary-teal);
  box-shadow: 0 0 0 3px rgba(13, 138, 128, 0.12);
}

.input-group.floating label {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  color: var(--text-muted);
  pointer-events: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: left center;
}

.input-group.floating input:focus + label,
.input-group.floating input:not(:placeholder-shown) + label {
  top: 10px;
  transform: translateY(0) scale(0.75);
  color: var(--primary-teal);
  font-weight: 600;
}

.input-highlight {
  position: absolute;
  bottom: 0;
  left: 50%;
  width: 0;
  height: 2px;
  background: var(--primary-teal);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  transform: translateX(-50%);
  border-radius: 0 0 10px 10px;
}

.input-group.floating input:focus ~ .input-highlight {
  width: 100%;
}

/* --- Password Toggle --- */
.password-toggle {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: color 0.2s ease, background 0.2s ease;
}

.password-toggle:hover {
  color: var(--dark-charcoal);
  background: rgba(0, 0, 0, 0.05);
}

.password-toggle:focus-visible {
  outline: 2px solid var(--primary-teal);
  outline-offset: 2px;
}

/* --- Error Message --- */
.login-error {
  font-size: 13px;
  color: var(--badge-red-text);
  font-weight: 600;
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: 6px;
  animation: errorShake 0.4s ease;
}

@keyframes errorShake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-6px); }
  40% { transform: translateX(6px); }
  60% { transform: translateX(-4px); }
  80% { transform: translateX(4px); }
}

/* --- Form Options (Remember Me + Forgot) --- */
.form-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.remember-me {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.remember-me input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--primary-teal);
  cursor: pointer;
}

.forgot-link {
  font-size: 13px;
  color: var(--primary-teal);
  text-decoration: none;
  font-weight: 600;
  transition: color 0.2s ease;
}

.forgot-link:hover {
  color: var(--primary-dark);
  text-decoration: underline;
}

/* --- Submit Button --- */
.login-btn {
  width: 100%;
  min-height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 20px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, #0d8a80 0%, #0a7a71 100%);
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  letter-spacing: 0.3px;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.login-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.15) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 0.25s ease;
}

.login-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(13, 138, 128, 0.35);
}

.login-btn:hover::before {
  opacity: 1;
}

.login-btn:active {
  transform: translateY(0) scale(0.98);
  box-shadow: 0 4px 12px rgba(13, 138, 128, 0.25);
}

.login-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.login-btn.is-loading {
  background: var(--primary-dark);
  cursor: wait;
  pointer-events: none;
}

.btn-content {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: opacity 0.2s ease;
}

.login-btn.is-loading .btn-content {
  opacity: 0;
}

.btn-arrow {
  transition: transform 0.2s ease;
}

.login-btn:hover .btn-arrow {
  transform: translateX(3px);
}

.login-btn.is-loading .btn-arrow {
  opacity: 0;
}

/* --- Spinner --- */
.login-btn-spinner {
  position: absolute;
  width: 22px;
  height: 22px;
  border: 2.5px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: loginSpinner 0.7s linear infinite;
}

.login-btn-spinner[hidden] {
  display: none;
}

@keyframes loginSpinner {
  to { transform: rotate(360deg); }
}

/* --- Progress Text --- */
.login-progress {
  min-height: 18px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  text-align: center;
}

/* --- Footer --- */
.login-footer {
  margin-top: 32px;
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.footer-dot {
  opacity: 0.4;
}

/* ================================================================
   MOBILE RESPONSIVE
   ================================================================ */
@media (max-width: 768px) {
  .login-container {
    flex-direction: column;
    max-width: 420px;
    min-height: auto;
    margin: 16px;
    border-radius: 16px;
  }

  .login-brand-panel {
    padding: 32px 28px;
    min-height: auto;
  }

  .brand-name {
    font-size: 22px;
    letter-spacing: 3px;
  }

  .brand-features {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 12px;
  }

  .feature-item {
    font-size: 12px;
  }

  .feature-item svg {
    width: 16px;
    height: 16px;
  }

  .brand-footer {
    display: none;
  }

  .login-form-panel {
    padding: 32px 28px;
  }

  .form-header h2 {
    font-size: 20px;
  }

  .form-header p {
    font-size: 13px;
  }
}

@media (max-width: 480px) {
  .login-container {
    margin: 8px;
    border-radius: 12px;
  }

  .login-brand-panel {
    padding: 24px 20px;
  }

  .brand-name {
    font-size: 18px;
    letter-spacing: 2px;
  }

  .brand-tagline {
    font-size: 11px;
    margin-bottom: 24px;
  }

  .brand-features {
    display: none;
  }

  .login-form-panel {
    padding: 24px 20px;
  }

  .form-header {
    margin-bottom: 24px;
  }

  .form-header h2 {
    font-size: 18px;
  }

  .login-form {
    gap: 16px;
  }

  .input-group.floating input {
    padding: 14px 12px 8px;
    font-size: 14px;
  }

  .login-btn {
    min-height: 44px;
    font-size: 14px;
  }
}

/* ================================================================
   ACCESSIBILITY
   ================================================================ */
@media (prefers-reduced-motion: reduce) {
  .login-container { animation: none; }
  .login-btn-spinner { animation: none; }
  .login-error { animation: none; }
  .input-highlight { transition: none; }
}

@media (prefers-contrast: high) {
  .input-group.floating input {
    border-width: 2px;
  }

  .login-btn {
    border: 2px solid #ffffff;
  }
}

/* Focus visible for keyboard navigation */
.login-form *:focus-visible {
  outline: 2px solid var(--primary-teal);
  outline-offset: 2px;
}

/* ================================================================
   DARK MODE SUPPORT
   ================================================================ */
body.dark-mode .login-overlay {
  background: #060a14;
}

body.dark-mode .login-brand-panel {
  background: linear-gradient(135deg, #0a6b62 0%, #074f48 60%, #053d32 100%);
}

body.dark-mode .input-group.floating input {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.15);
  color: #f1f5f9;
}

body.dark-mode .input-group.floating input:focus {
  border-color: var(--primary-teal);
  box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.2);
}

body.dark-mode .input-group.floating label {
  color: rgba(255, 255, 255, 0.5);
}

body.dark-mode .input-group.floating input:focus + label,
body.dark-mode .input-group.floating input:not(:placeholder-shown) + label {
  color: var(--primary-teal);
}

body.dark-mode .password-toggle:hover {
  color: #f1f5f9;
  background: rgba(255, 255, 255, 0.1);
}

body.dark-mode .form-header h2 {
  color: #f1f5f9;
}

body.dark-mode .form-header p {
  color: rgba(255, 255, 255, 0.6);
}

body.dark-mode .remember-me {
  color: rgba(255, 255, 255, 0.7);
}

body.dark-mode .forgot-link {
  color: #2dd4bf;
}

body.dark-mode .login-footer {
  color: rgba(255, 255, 255, 0.4);
}'''

# ============================================================
# 3. APPLY CHANGES
# ============================================================
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

with open('styles.css', 'r', encoding='utf-8') as f:
    css = f.read()

# Apply HTML changes
if OLD_LOGIN_HTML in html:
    html = html.replace(OLD_LOGIN_HTML, NEW_LOGIN_HTML)
    print("[OK] HTML: Login section replaced")
else:
    print("[WARN] HTML: Old login section not found (may have been modified)")

# Apply CSS changes
if OLD_LOGIN_CSS in css:
    css = css.replace(OLD_LOGIN_CSS, NEW_LOGIN_CSS)
    print("[OK] CSS: Login styles replaced")
else:
    print("[WARN] CSS: Old login styles not found (may have been modified)")

with open('index.html', 'w', encoding='utf-8', newline='') as f:
    f.write(html)

with open('styles.css', 'w', encoding='utf-8', newline='') as f:
    f.write(css)

# Verify
with open('index.html', 'r') as f:
    v = f.read()
assert 'login-container' in v, "new container missing"
assert 'login-brand-panel' in v, "brand panel missing"
assert 'login-form-panel' in v, "form panel missing"
assert 'floating' in v, "floating labels missing"
assert 'password-toggle' in v, "password toggle class missing"
assert 'v3.10.0' in v, "version bump missing"

with open('styles.css', 'r') as f:
    v = f.read()
assert 'loginSlideUp' in v, "animation missing"
assert '@media (max-width: 768px)' in v, "mobile responsive missing"
assert '@media (prefers-reduced-motion' in v, "accessibility missing"
assert 'dark-mode .login' in v, "dark mode missing"

print("[OK] All verifications passed")
