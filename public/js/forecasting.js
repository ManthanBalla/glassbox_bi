/**
 * GlassBox-BI: Forecasting Agent Controller
 * Manages 4-step workflow, dataset inspection, eligibility checks,
 * live polling, Chart.js multi-series visualizations, and decision log rendering.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Global State
  let currentUser = null;
  let availableDatasets = [];
  let selectedDataset = null;
  let precheckData = null;
  let visibleForecastRows = 15;
  let latestForecastPoints = [];
  let reportConfidenceLevels = [0.80, 0.95];
  const modelPurpose = {
    'Seasonal Naive': 'Baseline',
    'ETS (Exponential Smoothing)': 'Trend + seasonality',
    'ARIMA / SARIMA': 'Autoregressive patterns',
    Prophet: 'Trend + calendar seasonality',
    LightGBM: 'Lag + calendar features',
    LSTM: 'Sequence patterns',
    Theta: 'Trend/level forecasting'
  };
  const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
  const frequencyName = code => ({D: 'Daily', W: 'Weekly', M: 'Monthly', MS: 'Monthly', Q: 'Quarterly', QS: 'Quarterly', Y: 'Yearly', YS: 'Yearly'})[String(code || 'D').toUpperCase()] || code || 'Daily';
  const horizonUnit = code => ({D: 'days', W: 'weeks', M: 'months', MS: 'months', Q: 'quarters', QS: 'quarters', Y: 'years', YS: 'years'})[String(code || 'D').toUpperCase()] || 'periods';
  let currentJobId = null;
  let pollingInterval = null;

  // Chart Instances
  let mainForecastChartInstance = null;
  let holdoutChartInstance = null;

  // DOM Elements
  const alertBanner = document.getElementById('agent-alert-banner');
  const userProfileName = document.getElementById('user-profile-name');
  const userAvatarCircle = document.getElementById('user-avatar-circle');
  const dropdownFullName = document.getElementById('dropdown-full-name');
  const dropdownEmail = document.getElementById('dropdown-email');
  const btnLogout = document.getElementById('btn-logout');
  const profileButton = document.getElementById('profile-menu-button');
  const profileDropdown = document.getElementById('profile-dropdown');

  // Stepper Elements
  const stepPanels = {
    1: document.getElementById('panel-step-1'),
    2: document.getElementById('panel-step-2'),
    3: document.getElementById('panel-step-3'),
    4: document.getElementById('panel-step-4')
  };
  const stepperSteps = {
    1: document.getElementById('stepper-step-1'),
    2: document.getElementById('stepper-step-2'),
    3: document.getElementById('stepper-step-3'),
    4: document.getElementById('stepper-step-4')
  };

  // Helper: Display Alert Banner
  function showAlert(msg, type = 'error') {
    if (!alertBanner) return;
    alertBanner.textContent = msg;
    alertBanner.className = `alert alert-${type}`;
    alertBanner.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function hideAlert() {
    if (alertBanner) alertBanner.style.display = 'none';
  }

  // Helper: Switch Stepper
  function goToStep(stepNum) {
    hideAlert();
    Object.keys(stepPanels).forEach(s => {
      const isCurrent = parseInt(s) === stepNum;
      stepPanels[s].classList.toggle('active', isCurrent);
      if (parseInt(s) < stepNum) {
        stepperSteps[s].className = 'stepper-step completed';
      } else if (isCurrent) {
        stepperSteps[s].className = 'stepper-step active';
      } else {
        stepperSteps[s].className = 'stepper-step';
      }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // -------------------------------------------------------------
  // 1. AUTHENTICATION & PROFILE MENU
  // -------------------------------------------------------------
  async function initAuth() {
    try {
      const data = await api.get('/api/auth/me');
      if (!data.success || !data.user) {
        window.location.href = '/login.html';
        return;
      }
      currentUser = data.user;

      if (userProfileName) userProfileName.textContent = currentUser.full_name || 'Analyst';
      if (dropdownFullName) dropdownFullName.textContent = currentUser.full_name || 'Analyst';
      if (dropdownEmail) dropdownEmail.textContent = currentUser.email || '';
      if (userAvatarCircle) {
        const initials = (currentUser.full_name || 'U').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        userAvatarCircle.textContent = initials;
      }

      if (profileButton && profileDropdown) {
        profileButton.addEventListener('click', (e) => {
          e.stopPropagation();
          const isExpanded = profileDropdown.style.display === 'block';
          profileDropdown.style.display = isExpanded ? 'none' : 'block';
          profileButton.setAttribute('aria-expanded', !isExpanded);
        });

        document.addEventListener('click', (e) => {
          if (!profileButton.contains(e.target) && !profileDropdown.contains(e.target)) {
            profileDropdown.style.display = 'none';
            profileButton.setAttribute('aria-expanded', 'false');
          }
        });
      }

      if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
          try {
            await api.post('/api/auth/logout', {});
          } catch (e) {}
          window.location.href = '/login.html';
        });
      }
    } catch (err) {
      window.location.href = '/login.html';
    }
  }

  // -------------------------------------------------------------
  // 2. STEP 1: LOAD COMPLETED PROCESSED DATASETS
  // -------------------------------------------------------------
  async function loadProcessedDatasets() {
    const spinner = document.getElementById('dataset-loading-spinner');
    const emptyState = document.getElementById('dataset-empty-state');
    const tableContainer = document.getElementById('datasets-table-container');
    const tbody = document.getElementById('datasets-tbody');
    const btnToStep2 = document.getElementById('btn-to-step-2');

    try {
      const res = await api.get('/api/agents/forecasting/datasets');
      spinner.style.display = 'none';

      if (!res.success || !res.datasets || res.datasets.length === 0) {
        emptyState.style.display = 'block';
        tableContainer.style.display = 'none';
        return;
      }

      availableDatasets = res.datasets;
      const requestedDatasetId = new URLSearchParams(window.location.search).get('dataset');
      const preferredIndex = Math.max(0, availableDatasets.findIndex(ds => String(ds.id) === requestedDatasetId));
      emptyState.style.display = 'none';
      tableContainer.style.display = 'block';
      tbody.innerHTML = '';

      availableDatasets.forEach((ds, idx) => {
        const tr = document.createElement('label');
        tr.className = 'dataset-choice';

        const isFirst = idx === preferredIndex;
        if (isFirst) selectedDataset = ds;

        const dateStr = ds.created_at ? new Date(ds.created_at).toLocaleDateString() : '-';
        const readinessScore = ds.readiness_score !== null ? parseFloat(ds.readiness_score) : null;
        const readinessBadgeClass = readinessScore >= 80 ? 'badge-teal' : (readinessScore >= 50 ? 'badge-warning' : 'badge-error');
        const contract = ds.data_contract || {};
        const quality = ds.quality_score_after ?? contract.data_quality_score;

        tr.innerHTML = `
          <input type="radio" name="dataset_select" value="${safe(ds.id)}" ${isFirst ? 'checked' : ''}>
          <div><strong>${safe(ds.source_file_name || 'Cleaned dataset')}</strong><span class="compact-note">CSV · ${(ds.rows_after || contract.observations || 0).toLocaleString()} observations · ${safe(frequencyName(ds.frequency || contract.frequency))} · Target: ${safe(ds.target_column || contract.target_column)}</span></div>
          <div class="dataset-scores"><span>Quality ${quality ?? '—'}/100</span><span class="badge ${readinessBadgeClass}">Readiness ${readinessScore ?? '—'}/100</span><small>${safe(dateStr)}</small></div>
        `;

        tr.addEventListener('click', () => {
          tr.querySelector('input[type="radio"]').checked = true;
          selectedDataset = ds;
          btnToStep2.disabled = false;
        });

        tbody.appendChild(tr);
      });

      btnToStep2.disabled = false;
    } catch (err) {
      spinner.style.display = 'none';
      showAlert('Failed to load preprocessed datasets: ' + err.message);
    }
  }

  // -------------------------------------------------------------
  // 3. STEP 2: PRE-CHECK & MODEL ELIGIBILITY
  // -------------------------------------------------------------
  const btnToStep2 = document.getElementById('btn-to-step-2');
  if (btnToStep2) {
    btnToStep2.addEventListener('click', async () => {
      if (!selectedDataset) return;

      btnToStep2.disabled = true;
      btnToStep2.textContent = 'Inspecting & Pre-Checking...';
      hideAlert();

      try {
        const res = await api.post('/api/agents/forecasting/precheck', {
          processedDatasetId: selectedDataset.id
        });

        if (!res.success) {
          throw new Error(res.error || res.message || 'Pre-check failed');
        }

        precheckData = res;
        renderPrecheckStep(res);
        goToStep(2);
      } catch (err) {
        showAlert('This dataset is not ready for forecasting. Review its dates, target values, and preprocessing result.');
        const detail = document.createElement('details');
        detail.innerHTML = `<summary>View technical reason</summary><pre>${safe(err.message)}</pre>`;
        alertBanner.appendChild(detail);
      } finally {
        btnToStep2.disabled = false;
        btnToStep2.innerHTML = 'Continue &rarr;';
      }
    });
  }

  function renderPrecheckStep(data) {
    document.getElementById('chk-rows').textContent = (data.total_rows || 0).toLocaleString();
    document.getElementById('chk-freq').textContent = frequencyName(data.frequency);
    const seasonLabel = data.seasonal_period === 7 ? 'Weekly' : (data.seasonal_period === 52 ? 'Yearly' : (data.seasonal_period === 12 ? 'Yearly' : (data.seasonal_period === 4 ? 'Yearly' : 'None')));
    document.getElementById('chk-period').textContent = `${seasonLabel} cycle · m=${data.seasonal_period || 1}`;
    document.getElementById('chk-target').textContent = data.target_column || 'Target';

    // Validation badge
    const badgeWrap = document.getElementById('precheck-badge-wrap');
    const valStatus = (data.validation && data.validation.status) || 'pass';
    if (valStatus === 'pass') {
      badgeWrap.innerHTML = '<span class="badge badge-teal">Ready for model evaluation</span>';
    } else if (valStatus === 'warn') {
      badgeWrap.innerHTML = '<span class="badge badge-warning">Ready with warnings</span>';
    } else {
      badgeWrap.innerHTML = '<span class="badge badge-error">Pre-check blocked</span>';
    }

    const checks = data.validation?.checks || {};
    const health = [
      [`${(data.total_rows || 0).toLocaleString()} observations`, checks.sufficient_history],
      ['Valid dates', checks.valid_dates],
      ['No duplicate timestamps', checks.unique_dates],
      [checks.regular_frequency ? 'Regular frequency' : `${checks.missing_periods ?? 'Some'} missing or off-cycle periods`, checks.regular_frequency],
      ['Complete target values', checks.complete_target],
      ['Target has variation', checks.target_variation],
      ['Sufficient history', checks.sufficient_history]
    ];
    document.getElementById('health-container').innerHTML = health.map(([label, ok]) => `<span class="health-item ${ok ? 'pass' : 'blocked'}">${ok ? '✓' : '✕'} ${safe(label)}</span>`).join('');

    // Render eligibility cards
    const eligContainer = document.getElementById('eligibility-container');
    eligContainer.innerHTML = '';
    const elig = data.eligibility || {};

    Object.keys(elig).forEach(mName => {
      const info = elig[mName];
      const isEligible = info.eligible;
      const statusClass = isEligible ? 'status-eligible' : (info.status === 'unavailable' ? 'status-unavailable' : 'status-skipped');
      const badgeHtml = isEligible
        ? '<span class="badge badge-teal" style="font-size: 0.72rem;">Eligible</span>'
        : `<span class="badge" style="background: #fef3c7; color: #92400e; font-size: 0.72rem;">${info.status === 'unavailable' ? 'Unavailable' : 'Skipped'}</span>`;

      const card = document.createElement('details');
      card.className = `portfolio-row ${statusClass}`;
      card.innerHTML = `
        <summary><strong>${safe(mName)}</strong><small>${safe(modelPurpose[mName])}</small>${badgeHtml}<span class="row-chevron">Details</span></summary>
        <p class="eligibility-reason">${safe(info.reason)}</p>
      `;
      eligContainer.appendChild(card);
    });
    const eligibleCount = Object.values(elig).filter(item => item.eligible).length;
    document.getElementById('eligibility-count').textContent = `${eligibleCount} of ${Object.keys(elig).length} candidates available`;
    document.getElementById('precheck-recommendation').textContent = `${eligibleCount} candidates available · ${seasonLabel} cycle assumed from frequency · Recommended: run multi-model evaluation.`;

    // Prefill Step 3 Horizon
    const horizonInput = document.getElementById('cfg-horizon');
    if (horizonInput && data.suggested_horizon) {
      horizonInput.value = data.suggested_horizon;
    }

    // Populate model checklist for Step 3
    populateModelChecklist(elig);
    updateHorizonHelper();
  }

  function populateModelChecklist(elig) {
    const checklistBox = document.getElementById('model-checklist-box');
    checklistBox.innerHTML = '';

    const allModels = [
      { id: 'Seasonal Naive', name: 'Seasonal Naive', sub: 'Baseline' },
      { id: 'ETS (Exponential Smoothing)', name: 'ETS (Exponential Smoothing)', sub: 'Trend + seasonality' },
      { id: 'ARIMA / SARIMA', name: 'ARIMA / SARIMA', sub: 'Autoregressive patterns' },
      { id: 'Prophet', name: 'Prophet', sub: 'Trend + calendar seasonality' },
      { id: 'LightGBM', name: 'LightGBM', sub: 'Lag + calendar features' },
      { id: 'LSTM', name: 'LSTM', sub: 'Sequence patterns' },
      { id: 'Theta', name: 'Theta', sub: 'Trend/level forecasting' }
    ];

    allModels.forEach(m => {
      const info = elig[m.name] || { eligible: true, reason: 'Eligible' };
      const isEligible = info.eligible;

      const item = document.createElement('label');
      item.className = `model-check-item ${isEligible ? '' : 'disabled'}`;
      item.innerHTML = `
        <input type="checkbox" name="models" value="${m.name}" ${isEligible ? 'checked' : ''} ${!isEligible || m.name === 'Seasonal Naive' ? 'disabled' : ''}>
        <div class="model-check-label">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="model-check-title">${safe(m.name)}</span>
            ${isEligible ? '' : '<span class="badge" style="font-size: 0.65rem; background: #e2e8f0; color: #64748b;">Skipped</span>'}
          </div>
          <span class="model-check-sub">${safe(isEligible ? m.sub : info.reason)}</span>
        </div>
      `;
      checklistBox.appendChild(item);
    });
  }

  function updateHorizonHelper() {
    const count = Number(document.getElementById('cfg-horizon').value) || 12;
    const unit = horizonUnit(precheckData?.frequency || selectedDataset?.frequency);
    document.getElementById('horizon-helper').textContent = `Next ${count} ${unit}`;
    const models = document.querySelectorAll('#model-checklist-box input[type="checkbox"]:checked').length;
    document.getElementById('setup-summary').textContent = `Recommended setup · ${count} ${unit} · ${document.getElementById('cfg-metric').value.toUpperCase()} · ${Math.round(Number(document.getElementById('cfg-holdout').value) * 100)}% holdout · ${models} models including baseline`;
  }
  ['cfg-horizon', 'cfg-metric', 'cfg-holdout'].forEach(id => document.getElementById(id)?.addEventListener('change', updateHorizonHelper));
  document.getElementById('model-checklist-box')?.addEventListener('change', updateHorizonHelper);

  // Step 2 & 3 navigation
  document.getElementById('btn-back-to-step-1')?.addEventListener('click', () => goToStep(1));
  document.getElementById('btn-to-step-3')?.addEventListener('click', () => goToStep(3));
  document.getElementById('btn-back-to-step-2')?.addEventListener('click', () => goToStep(2));
  document.getElementById('btn-process-another')?.addEventListener('click', () => {
    goToStep(1);
    loadProcessedDatasets();
    loadJobHistory();
  });

  // -------------------------------------------------------------
  // 4. STEP 3: SUBMIT FORECASTING JOB
  // -------------------------------------------------------------
  const forecastForm = document.getElementById('forecasting-config-form');
  if (forecastForm) {
    forecastForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selectedDataset) return;

      const horizon = parseInt(document.getElementById('cfg-horizon').value, 10) || 12;
      const metric = document.getElementById('cfg-metric').value || 'rmse';
      const holdoutPercent = parseFloat(document.getElementById('cfg-holdout').value) || 0.20;
      const confChoice = document.getElementById('cfg-confidence').value;

      let confidenceLevels = [0.80, 0.95];
      if (confChoice === '95') confidenceLevels = [0.95];
      if (confChoice === '80') confidenceLevels = [0.80];

      const checkedBoxes = Array.from(document.querySelectorAll('#model-checklist-box input[type="checkbox"]:checked'));
      const selectedModelNames = ['Seasonal Naive', ...checkedBoxes.map(b => b.value).filter(name => name !== 'Seasonal Naive')];

      goToStep(4);
      const runningCard = document.getElementById('forecast-running-card');
      const completedContainer = document.getElementById('forecast-completed-container');
      const runningStatus = document.getElementById('forecast-running-status');

      runningCard.style.display = 'block';
      completedContainer.style.display = 'none';
      runningStatus.textContent = 'Validating data';
      renderProgress(0);

      try {
        const runRes = await api.post('/api/agents/forecasting/run', {
          processedDatasetId: selectedDataset.id,
          config: {
            horizon,
            metric,
            holdoutPercent,
            confidenceLevels,
            models: selectedModelNames
          }
        });

        if (!runRes.success || !runRes.jobId) {
          throw new Error(runRes.message || 'Failed to queue forecasting job');
        }

        currentJobId = runRes.jobId;
        pollJobStatus(currentJobId);
      } catch (err) {
        runningCard.style.display = 'none';
        showAlert('The forecast could not be started. Review the configuration and try again.');
        const detail = document.createElement('details');
        detail.innerHTML = `<summary>View technical reason</summary><pre>${safe(err.message)}</pre>`;
        alertBanner.appendChild(detail);
        goToStep(3);
      }
    });
  }

  // -------------------------------------------------------------
  // 5. LIVE POLLING & STEP 4 RENDERING
  // -------------------------------------------------------------
  function renderProgress(active) {
    const stages = ['Validating data', 'Checking model eligibility', 'Training candidate models', 'Evaluating models', 'Selecting best model', 'Generating future forecast'];
    document.getElementById('forecast-progress-list').innerHTML = stages.map((stage, index) => `<span class="progress-item ${index < active ? 'done' : (index === active ? 'current' : '')}">${index < active ? '✓' : (index === active ? '●' : '○')} ${stage}</span>`).join('');
  }

  function pollJobStatus(jobId) {
    if (pollingInterval) clearInterval(pollingInterval);

    const runningStatus = document.getElementById('forecast-running-status');

    pollingInterval = setInterval(async () => {
      try {
        const res = await api.get(`/api/agents/forecasting/jobs/${jobId}`);
        if (!res.success || !res.job) return;

        const job = res.job;
        const progressIndex = {validating: 0, eligibility: 1, training: 2, evaluating: 3, selecting: 4, forecasting: 5, completed: 6}[job.progress_stage];
        if (progressIndex !== undefined) {
          renderProgress(progressIndex);
          const stageText = ['Validating data', 'Checking model eligibility', 'Training candidate models', 'Evaluating models', 'Selecting best model', 'Generating future forecast'][Math.min(progressIndex, 5)];
          runningStatus.textContent = stageText;
        }
        if (job.status === 'validating') {
          if (progressIndex === undefined) renderProgress(0);
        } else if (job.status === 'training') {
          if (progressIndex === undefined) renderProgress(2);
        } else if (job.status === 'evaluating') {
          if (progressIndex === undefined) renderProgress(4);
        } else if (job.status === 'completed') {
          renderProgress(6);
          clearInterval(pollingInterval);
          pollingInterval = null;
          await renderCompletedForecast(jobId);
        } else if (job.status === 'failed') {
          clearInterval(pollingInterval);
          pollingInterval = null;
          document.getElementById('forecast-running-card').style.display = 'none';
          showAlert('Forecasting could not be completed. Review target values, history length, frequency, or model selection.');
          const detail = document.createElement('details');
          detail.innerHTML = `<summary>View technical error</summary><pre>${safe(job.error_message || 'No eligible model successfully produced a forecast.')}</pre>`;
          alertBanner.appendChild(detail);
          goToStep(3);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1500);
  }

  async function renderCompletedForecast(jobId) {
    const runningCard = document.getElementById('forecast-running-card');
    const completedContainer = document.getElementById('forecast-completed-container');

    try {
      const [reportRes, forecastDataRes] = await Promise.all([
        api.get(`/api/agents/forecasting/jobs/${jobId}/report`),
        api.get(`/api/agents/forecasting/jobs/${jobId}/forecast`)
      ]);

      if (!reportRes.success || !forecastDataRes.success) {
        throw new Error('Failed to retrieve forecast results');
      }

      runningCard.style.display = 'none';
      completedContainer.style.display = 'block';

      const job = reportRes.job;
      const leaderboard = reportRes.leaderboard || [];
      const auditActions = reportRes.audit_actions || [];
      const winnerName = job.winner_model || (leaderboard[0] ? leaderboard[0].model_name : 'Winner');
      const disk = reportRes.disk_report || {};
      const evidence = disk.winner_evidence || {};
      const levels = disk.confidence_levels || [0.80, 0.95];
      reportConfidenceLevels = levels;
      visibleForecastRows = 15;

      // 1. Winner Hero Banner
      document.getElementById('winner-model-name').textContent = winnerName;
      document.getElementById('chart-winner-badge').textContent = winnerName;
      document.getElementById('winner-metric-label').textContent = (job.selected_metric || 'RMSE').toUpperCase();

      const winnerRow = leaderboard.find(r => r.model_name === winnerName) || leaderboard[0] || {};
      const metricKey = (job.selected_metric || 'rmse').toLowerCase();
      document.getElementById('winner-metric-val').textContent = winnerRow[metricKey] ?? '-';

      const baselineRow = leaderboard.find(r => r.model_name === 'Seasonal Naive');
      let improvementText = '';
      if (baselineRow && Number(winnerRow[metricKey]) >= 0 && Number(baselineRow[metricKey]) > 0 && winnerName !== 'Seasonal Naive') {
        const pctDiff = ((baselineRow[metricKey] - winnerRow[metricKey]) / baselineRow[metricKey] * 100).toFixed(1);
        improvementText = ` Outperformed Seasonal Naive baseline by ${pctDiff}%.`;
      }
      document.getElementById('winner-model-reason').textContent =
        `${winnerName} achieved the lowest ${metricKey.toUpperCase()} on the chronological holdout.${improvementText}`;
      document.getElementById('result-horizon').textContent = `${job.horizon} periods`;
      document.getElementById('result-model-count').textContent = leaderboard.filter(row => row.status === 'ok').length;
      document.getElementById('result-quality').textContent = winnerName === 'Seasonal Naive' ? 'Baseline strongest' : 'Better than baseline';
      const contract = disk.preprocessing_contract || {};
      const quality = job.quality_score_after ?? '—';
      const readiness = job.readiness_score ?? contract.forecast_readiness ?? '—';
      document.getElementById('result-data-health').textContent = `${quality} / ${readiness}`;
      const horizonWarning = document.getElementById('horizon-warning');
      if (disk.requested_horizon && disk.horizon !== disk.requested_horizon) {
        horizonWarning.style.display = 'block';
        horizonWarning.textContent = `Horizon adjusted: ${disk.requested_horizon} requested, ${disk.horizon} used because the request was large relative to available history.`;
      } else horizonWarning.style.display = 'none';
      document.getElementById('winner-evidence').innerHTML = `<strong>Why ${safe(winnerName)} won</strong><p>Lowest holdout ${safe(metricKey.toUpperCase())}: ${safe(winnerRow[metricKey] ?? '—')}. ${evidence.runner_up ? `Next best: ${safe(evidence.runner_up)} (${safe(evidence.runner_up_score)}). ${evidence.runner_up_improvement_percent == null ? '' : `${safe(evidence.runner_up_improvement_percent)}% lower error.`}` : 'Only one model completed evaluation.'}</p>`;
      document.getElementById('baseline-comparison').innerHTML = baselineRow ? `<strong>Baseline comparison</strong><p>Seasonal Naive ${safe(metricKey.toUpperCase())}: ${safe(baselineRow[metricKey] ?? '—')}. ${winnerName === 'Seasonal Naive' ? 'Baseline remains the strongest model.' : `${safe(winnerName)}: ${safe(winnerRow[metricKey] ?? '—')} (${evidence.baseline_improvement_percent ?? '—'}% lower error).`}</p>` : '';
      document.getElementById('forecast-chart-note').textContent = `Forecast begins after the last historical observation. ${levels.map(level => `${Math.round(level * 100)}%`).join(' and ')} model-based interval${levels.length > 1 ? 's' : ''} shown; coverage is not guaranteed.`;
      document.querySelectorAll('.bound-80').forEach(el => el.style.display = levels.includes(0.80) ? '' : 'none');
      document.querySelectorAll('.bound-95').forEach(el => el.style.display = levels.includes(0.95) ? '' : 'none');

      // Baseline Warning Banner
      const baselineWarningBanner = document.getElementById('baseline-warning-banner');
      if (winnerName === 'Seasonal Naive' && leaderboard.some(r => r.status === 'ok' && r.model_name !== 'Seasonal Naive')) {
        baselineWarningBanner.style.display = 'block';
      } else {
        baselineWarningBanner.style.display = 'none';
      }

      // 2. Leaderboard Table
      const lTbody = document.getElementById('leaderboard-tbody');
      lTbody.innerHTML = '';
      leaderboard.forEach(r => {
        const tr = document.createElement('tr');
        const isWinner = r.model_name === winnerName;
        if (isWinner) tr.classList.add('winner-row');

        const statusBadge = r.status === 'ok'
          ? (isWinner ? '<span class="badge badge-teal" style="font-weight: 700;">WINNER</span>' : '<span class="badge badge-navy">OK</span>')
          : `<span class="badge badge-warning">${safe(r.status)}</span>`;

        tr.innerHTML = `
          <td>${r.status === 'ok' ? '#' + r.rank : '—'}</td>
          <td><strong>${safe(r.model_name)}</strong>${isWinner ? ' <span class="badge badge-teal">BEST MODEL</span>' : ''}</td>
          <td>${safe(r.rmse ?? '—')}</td>
          <td>${safe(r.mae ?? '—')}</td>
          <td>${r.smape == null ? '—' : safe(r.smape) + '%'}</td>
          <td>${safe(r.mase ?? '—')}</td>
          <td>${statusBadge}</td>
        `;
        lTbody.appendChild(tr);
      });

      // 3. Render Chart.js Visualizations
      renderMainForecastChart(forecastDataRes);
      renderHoldoutComparisonChart(forecastDataRes, winnerName);

      // 4. Decision Log Timeline
      renderAuditTimeline(auditActions);
      const summaryActions = auditActions.filter(a => ['validation_passed', 'winner_selected', 'forecast_generated', 'artifacts_saved'].includes(a.action));
      document.getElementById('decision-summary').innerHTML = summaryActions.map(a => `<span class="health-item pass">✓ ${safe(a.step_name.replaceAll('_', ' ').toLowerCase())}</span>`).join('');
      document.getElementById('model-details').innerHTML = leaderboard.map(row => `<details class="portfolio-row"><summary><strong>${safe(row.model_name)}</strong><span class="badge ${row.status === 'ok' ? 'badge-teal' : 'badge-warning'}">${safe(row.status)}</span></summary><p>${safe(row.skip_reason || disk.eligibility_decisions?.[row.model_name]?.reason || modelPurpose[row.model_name])}</p><p>RMSE ${safe(row.rmse ?? '—')} · MAE ${safe(row.mae ?? '—')} · sMAPE ${safe(row.smape ?? '—')} · MASE ${safe(row.mase ?? '—')}</p>${row.model_name === 'LightGBM' && row.status === 'ok' ? `<p>Uses backward-looking lag, rolling, and calendar features. Recursive forecasts use previous predictions as lag inputs.</p><p>${safe((disk.features_engineered || []).join(', '))}</p>` : ''}</details>`).join('');

      // 5. Projected Points Table
      renderForecastPointsTable(forecastDataRes.forecast || []);

      // 6. Download CSV Button
      const btnDownload = document.getElementById('btn-download-forecast-csv');
      btnDownload.href = `/api/agents/forecasting/jobs/${jobId}/download`;
      document.getElementById('btn-download-report').href = `/api/agents/forecasting/jobs/${jobId}/report/download`;

      // Refresh job history table at bottom
      loadJobHistory();
    } catch (err) {
      runningCard.style.display = 'none';
      showAlert('Error displaying forecast results: ' + err.message);
    }
  }

  // -------------------------------------------------------------
  // 6. CHART.JS VISUALIZATIONS
  // -------------------------------------------------------------
  function renderMainForecastChart(data) {
    const ctx = document.getElementById('mainForecastChart');
    if (!ctx) return;

    if (mainForecastChartInstance) {
      mainForecastChartInstance.destroy();
    }

    const history = data.history || [];
    const forecast = data.forecast || [];
    const levels = reportConfidenceLevels;

    // Slice last 60 history points for clear visibility if history is very long
    const plotHistory = history.length > 80 ? history.slice(-80) : history;

    const allDates = [
      ...plotHistory.map(h => h.date),
      ...forecast.map(f => f.forecast_date)
    ];

    const historyVals = plotHistory.map(h => h.value);
    const historyData = [...historyVals, ...Array(forecast.length).fill(null)];

    // Future forecast line starts from last history point to avoid disconnected line
    const lastHistVal = historyVals.length > 0 ? historyVals[historyVals.length - 1] : null;
    const futureVals = [
      ...Array(historyVals.length - 1).fill(null),
      lastHistVal,
      ...forecast.map(f => f.forecast_value)
    ];

    const lower95 = [
      ...Array(historyVals.length - 1).fill(null),
      lastHistVal,
      ...forecast.map(f => f.lower_95)
    ];
    const upper95 = [
      ...Array(historyVals.length - 1).fill(null),
      lastHistVal,
      ...forecast.map(f => f.upper_95)
    ];

    const lower80 = [
      ...Array(historyVals.length - 1).fill(null),
      lastHistVal,
      ...forecast.map(f => f.lower_80)
    ];
    const upper80 = [
      ...Array(historyVals.length - 1).fill(null),
      lastHistVal,
      ...forecast.map(f => f.upper_80)
    ];

    const chartDatasets = [
      {label: 'Historical actual', data: historyData, borderColor: '#1a2332', borderWidth: 2, pointRadius: 1},
      {label: 'Future forecast', data: futureVals, borderColor: '#0d9488', borderWidth: 2.5, pointRadius: 2}
    ];
    if (levels.includes(0.95)) {
      chartDatasets.push({label: '95% upper', data: upper95, borderColor: 'rgba(13,148,136,.18)', pointRadius: 0, fill: '+1', backgroundColor: 'rgba(13,148,136,.08)'});
      chartDatasets.push({label: '95% lower', data: lower95, borderColor: 'rgba(13,148,136,.18)', pointRadius: 0});
    }
    if (levels.includes(0.80)) {
      chartDatasets.push({label: '80% upper', data: upper80, borderColor: 'rgba(13,148,136,.35)', pointRadius: 0, fill: '+1', backgroundColor: 'rgba(13,148,136,.15)'});
      chartDatasets.push({label: '80% lower', data: lower80, borderColor: 'rgba(13,148,136,.35)', pointRadius: 0});
    }
    mainForecastChartInstance = new Chart(ctx, {
      type: 'line',
      plugins: [{
        id: 'forecastStart',
        afterDatasetsDraw(chart) {
          if (!historyVals.length || !forecast.length) return;
          const x = chart.scales.x.getPixelForValue(historyVals.length - 0.5);
          const {ctx: canvas, chartArea} = chart;
          canvas.save();
          canvas.strokeStyle = '#94a3b8';
          canvas.setLineDash([4, 4]);
          canvas.beginPath();
          canvas.moveTo(x, chartArea.top);
          canvas.lineTo(x, chartArea.bottom);
          canvas.stroke();
          canvas.setLineDash([]);
          canvas.fillStyle = '#475569';
          canvas.font = '11px Inter, sans-serif';
          canvas.fillText('Forecast start', Math.min(x + 5, chartArea.right - 82), chartArea.top + 12);
          canvas.restore();
        }
      }],
      data: {
        labels: allDates,
        datasets: chartDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              boxWidth: 12,
              font: { family: 'Inter', size: 11 },
              filter: (item) => !item.text.toLowerCase().includes('lower')
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxRotation: 45, font: { family: 'Inter', size: 10 } }
          },
          y: {
            grid: { color: 'rgba(226, 232, 240, 0.8)' },
            ticks: { font: { family: 'Inter', size: 10 } }
          }
        }
      }
    });
  }

  function renderHoldoutComparisonChart(data, winnerName) {
    const ctx = document.getElementById('holdoutComparisonChart');
    if (!ctx) return;

    if (holdoutChartInstance) {
      holdoutChartInstance.destroy();
    }

    const holdout = data.holdout || [];
    if (holdout.length === 0) return;

    const dates = holdout.map(h => h.date);
    const actualVals = holdout.map(h => h.actual);

    const datasets = [
      {
        label: 'Actual Ground Truth',
        data: actualVals,
        borderColor: '#1a2332',
        borderWidth: 2.5,
        pointRadius: 3,
        tension: 0.1
      }
    ];

    const modelCols = Object.keys(holdout[0]).filter(k => k !== 'date' && k !== 'actual');
    modelCols.filter(col => col === winnerName.replace(/ /g, '_').replace(/[()]/g, '').replace(/\//g, '_').toLowerCase()).forEach(col => {
      const colData = holdout.map(h => h[col]);
      const colName = col.replace(/_/g, ' ').toUpperCase();
      datasets.push({
        label: colName,
        data: colData,
        borderColor: '#0d9488',
        borderWidth: 1.5,
        borderDash: [4, 4],
        pointRadius: 2,
        tension: 0.1
      });
    });

    holdoutChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 9 } } }
        },
        scales: {
          x: { ticks: { font: { size: 9 }, maxRotation: 45 } },
          y: { grid: { color: 'rgba(226, 232, 240, 0.6)' }, ticks: { font: { size: 9 } } }
        }
      }
    });
  }

  // -------------------------------------------------------------
  // 7. AUDIT TIMELINE & POINTS TABLE
  // -------------------------------------------------------------
  function renderAuditTimeline(actions) {
    const container = document.getElementById('audit-timeline-container');
    container.innerHTML = '';

    if (!actions || actions.length === 0) {
      container.innerHTML = '<p style="color: var(--color-text-subtle);">No audit log events recorded.</p>';
      return;
    }

    actions.forEach(act => {
      const entry = document.createElement('div');
      entry.className = 'audit-entry';
      entry.innerHTML = `
        <div class="audit-marker"></div>
        <div class="audit-card">
          <div class="audit-header">
            <span class="step-chip">${safe(act.step_name)}</span>
            ${act.model_name ? `<span class="model-chip">${safe(act.model_name)}</span>` : ''}
          </div>
          <p class="audit-desc">${safe(act.description)}</p>
        </div>
      `;
      container.appendChild(entry);
    });
  }

  function renderForecastPointsTable(points) {
    const tbody = document.getElementById('forecast-points-tbody');
    tbody.innerHTML = '';

    const badge = document.getElementById('forecast-horizon-badge');
    badge.textContent = `${points.length} Periods Projected`;

    latestForecastPoints = points;
    points.slice(0, visibleForecastRows).forEach(pt => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 600; color: var(--color-primary);">${pt.forecast_date}</td>
        <td style="font-weight: 700; color: #0284c7;">${parseFloat(pt.forecast_value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
        <td class="bound-80">${pt.lower_80 !== null ? parseFloat(pt.lower_80).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
        <td class="bound-80">${pt.upper_80 !== null ? parseFloat(pt.upper_80).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
        <td class="bound-95">${pt.lower_95 !== null ? parseFloat(pt.lower_95).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
        <td class="bound-95">${pt.upper_95 !== null ? parseFloat(pt.upper_95).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
      `;
      tbody.appendChild(tr);
    });
    const toggle = document.getElementById('btn-toggle-forecast-rows');
    toggle.style.display = points.length > 15 ? '' : 'none';
    toggle.textContent = visibleForecastRows < points.length ? 'View full forecast' : 'Show first 15 rows';
    document.querySelectorAll('.bound-80').forEach(el => el.style.display = reportConfidenceLevels.includes(0.80) ? '' : 'none');
    document.querySelectorAll('.bound-95').forEach(el => el.style.display = reportConfidenceLevels.includes(0.95) ? '' : 'none');
  }
  document.getElementById('btn-toggle-forecast-rows')?.addEventListener('click', () => {
    visibleForecastRows = visibleForecastRows < latestForecastPoints.length ? latestForecastPoints.length : 15;
    renderForecastPointsTable(latestForecastPoints);
  });

  // -------------------------------------------------------------
  // 8. JOB HISTORY
  // -------------------------------------------------------------
  async function loadJobHistory() {
    const tbody = document.getElementById('history-tbody');
    try {
      const res = await api.get('/api/agents/forecasting/jobs');
      if (!res.success || !res.jobs || res.jobs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--color-text-subtle); padding: 24px;">No forecasting jobs on record yet.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      res.jobs.forEach(job => {
        const tr = document.createElement('tr');
        const isCompleted = job.status === 'completed';
        const dateStr = job.created_at ? new Date(job.created_at).toLocaleString() : '-';

        const statusBadge = isCompleted
          ? '<span class="badge badge-teal">Completed</span>'
          : (job.status === 'failed' ? '<span class="badge badge-error">Failed</span>' : '<span class="badge badge-navy">Running</span>');

        const bestScore = job.rmse !== null && job.rmse !== undefined ? job.rmse : '-';

        tr.innerHTML = `
          <td><code>${job.id.substring(0, 8)}</code></td>
          <td style="font-weight: 600; color: var(--color-primary);">${job.source_file_name || 'Dataset'}</td>
          <td><span class="badge badge-teal">${job.target_column || 'target'}</span></td>
          <td>${job.horizon || 12}</td>
          <td><strong>${job.winner_model || '-'}</strong></td>
          <td>${bestScore}</td>
          <td>${statusBadge}</td>
          <td style="color: var(--color-text-muted); font-size: 0.8rem;">${dateStr}</td>
          <td>
            ${isCompleted ? `<button class="btn btn-secondary btn-sm btn-reopen-job" data-job-id="${job.id}">View Results</button>` : '-'}
          </td>
        `;

        if (isCompleted) {
          const btnView = tr.querySelector('.btn-reopen-job');
          btnView.addEventListener('click', () => {
            currentJobId = job.id;
            goToStep(4);
            renderCompletedForecast(job.id);
          });
        }

        tbody.appendChild(tr);
      });
    } catch (err) {
      console.error('Error loading forecasting history:', err);
    }
  }

  document.getElementById('btn-refresh-history')?.addEventListener('click', loadJobHistory);

  // Initialize
  initAuth();
  loadProcessedDatasets();
  loadJobHistory();
});
