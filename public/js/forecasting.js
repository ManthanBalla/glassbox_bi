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
  let currentJobId = null;
  let pollingInterval = null;

  // Chart Instances
  let mainForecastChartInstance = null;
  let errorMetricsChartInstance = null;
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
      emptyState.style.display = 'none';
      tableContainer.style.display = 'block';
      tbody.innerHTML = '';

      availableDatasets.forEach((ds, idx) => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';

        const isFirst = idx === 0;
        if (isFirst) selectedDataset = ds;

        const dateStr = ds.created_at ? new Date(ds.created_at).toLocaleDateString() : '-';
        const readinessScore = ds.readiness_score !== null ? parseFloat(ds.readiness_score) : 100;
        const readinessBadgeClass = readinessScore >= 80 ? 'badge-teal' : (readinessScore >= 50 ? 'badge-warning' : 'badge-error');

        tr.innerHTML = `
          <td>
            <input type="radio" name="dataset_select" value="${ds.id}" ${isFirst ? 'checked' : ''} style="cursor: pointer; accent-color: #0284c7;">
          </td>
          <td style="font-weight: 600; color: var(--color-primary);">${ds.source_file_name || 'Dataset'}</td>
          <td><span class="badge badge-teal" style="font-size: 0.72rem;">${ds.target_column || 'target'}</span></td>
          <td><code>${ds.date_column || 'date'}</code></td>
          <td><span class="badge badge-navy" style="font-size: 0.72rem;">${ds.frequency || 'D'}</span></td>
          <td>${(ds.rows_after || 0).toLocaleString()}</td>
          <td><span class="badge ${readinessBadgeClass}" style="font-size: 0.72rem;">${readinessScore}/100</span></td>
          <td style="color: var(--color-text-muted); font-size: 0.8rem;">${dateStr}</td>
        `;

        tr.addEventListener('click', (e) => {
          if (e.target.tagName !== 'INPUT') {
            const radio = tr.querySelector('input[type="radio"]');
            radio.checked = true;
          }
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
        showAlert('Pre-Check Error: ' + err.message);
      } finally {
        btnToStep2.disabled = false;
        btnToStep2.innerHTML = 'Inspect & Pre-Check Dataset &rarr;';
      }
    });
  }

  function renderPrecheckStep(data) {
    document.getElementById('chk-rows').textContent = (data.total_rows || 0).toLocaleString();
    document.getElementById('chk-freq').textContent = data.frequency || 'D';
    document.getElementById('chk-period').textContent = data.seasonal_period || 1;
    document.getElementById('chk-target').textContent = data.target_column || 'Target';

    // Validation badge
    const badgeWrap = document.getElementById('precheck-badge-wrap');
    const valStatus = (data.validation && data.validation.status) || 'pass';
    if (valStatus === 'pass') {
      badgeWrap.innerHTML = '<span class="badge badge-teal" style="font-size: 0.8rem; padding: 4px 10px;">Time-Series Validated: PASS</span>';
    } else if (valStatus === 'warn') {
      badgeWrap.innerHTML = '<span class="badge" style="background: #fef3c7; color: #92400e; font-size: 0.8rem; padding: 4px 10px;">Validated with Warnings</span>';
    } else {
      badgeWrap.innerHTML = '<span class="badge" style="background: #fee2e2; color: #991b1b; font-size: 0.8rem; padding: 4px 10px;">Validation: FAIL</span>';
    }

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

      const card = document.createElement('div');
      card.className = `eligibility-card ${statusClass}`;
      card.innerHTML = `
        <div>
          <div class="eligibility-header">
            <span class="eligibility-model-name">${mName}</span>
            ${badgeHtml}
          </div>
          <p class="eligibility-reason">${info.reason}</p>
        </div>
      `;
      eligContainer.appendChild(card);
    });

    // Prefill Step 3 Horizon
    const horizonInput = document.getElementById('cfg-horizon');
    if (horizonInput && data.suggested_horizon) {
      horizonInput.value = data.suggested_horizon;
    }

    // Populate model checklist for Step 3
    populateModelChecklist(elig);
  }

  function populateModelChecklist(elig) {
    const checklistBox = document.getElementById('model-checklist-box');
    checklistBox.innerHTML = '';

    const allModels = [
      { id: 'Seasonal Naive', name: 'Seasonal Naive', sub: 'Baseline model repeating previous cycle' },
      { id: 'ETS (Exponential Smoothing)', name: 'ETS (Exponential Smoothing)', sub: 'State-space exponential trend and seasonal smoothing' },
      { id: 'ARIMA / SARIMA', name: 'ARIMA / SARIMA', sub: 'Auto-order selected autoregressive integrated moving average' },
      { id: 'Prophet', name: 'Prophet', sub: 'Bayesian generalized additive model with holiday/seasonal priors' },
      { id: 'LightGBM', name: 'LightGBM', sub: 'Gradient boosting with recursive lag and rolling window features' },
      { id: 'Theta', name: 'Theta', sub: 'Dynamic decomposition into curvature and linear trend lines' }
    ];

    allModels.forEach(m => {
      const info = elig[m.name] || { eligible: true, reason: 'Eligible' };
      const isEligible = info.eligible;

      const item = document.createElement('label');
      item.className = `model-check-item ${isEligible ? '' : 'disabled'}`;
      item.innerHTML = `
        <input type="checkbox" name="models" value="${m.name}" ${isEligible ? 'checked' : 'disabled'}>
        <div class="model-check-label">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="model-check-title">${m.name}</span>
            ${isEligible ? '' : '<span class="badge" style="font-size: 0.65rem; background: #e2e8f0; color: #64748b;">Skipped</span>'}
          </div>
          <span class="model-check-sub">${isEligible ? m.sub : info.reason}</span>
        </div>
      `;
      checklistBox.appendChild(item);
    });
  }

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
      const selectedModelNames = checkedBoxes.map(b => b.value);

      if (selectedModelNames.length === 0) {
        showAlert('Please select at least one eligible model to run.');
        return;
      }

      goToStep(4);
      const runningCard = document.getElementById('forecast-running-card');
      const completedContainer = document.getElementById('forecast-completed-container');
      const runningStatus = document.getElementById('forecast-running-status');

      runningCard.style.display = 'block';
      completedContainer.style.display = 'none';
      runningStatus.textContent = 'Submitting job and preparing chronological holdout...';

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
        showAlert('Forecasting Job Error: ' + err.message);
        goToStep(3);
      }
    });
  }

  // -------------------------------------------------------------
  // 5. LIVE POLLING & STEP 4 RENDERING
  // -------------------------------------------------------------
  function pollJobStatus(jobId) {
    if (pollingInterval) clearInterval(pollingInterval);

    const runningStatus = document.getElementById('forecast-running-status');

    pollingInterval = setInterval(async () => {
      try {
        const res = await api.get(`/api/agents/forecasting/jobs/${jobId}`);
        if (!res.success || !res.job) return;

        const job = res.job;
        if (job.status === 'validating') {
          runningStatus.textContent = 'Validating series continuity and verifying seasonal bounds...';
        } else if (job.status === 'training') {
          runningStatus.textContent = 'Training candidate models on chronological training split...';
        } else if (job.status === 'evaluating') {
          runningStatus.textContent = 'Evaluating holdout error metrics (RMSE, MAE, sMAPE, MASE) and selecting winner...';
        } else if (job.status === 'completed') {
          clearInterval(pollingInterval);
          pollingInterval = null;
          await renderCompletedForecast(jobId);
        } else if (job.status === 'failed') {
          clearInterval(pollingInterval);
          pollingInterval = null;
          document.getElementById('forecast-running-card').style.display = 'none';
          showAlert(`Forecasting Job Failed: ${job.error_message || 'Unknown execution error'}`);
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

      // 1. Winner Hero Banner
      document.getElementById('winner-model-name').textContent = winnerName;
      document.getElementById('chart-winner-badge').textContent = winnerName;
      document.getElementById('winner-metric-label').textContent = (job.selected_metric || 'RMSE').toUpperCase();

      const winnerRow = leaderboard.find(r => r.model_name === winnerName) || leaderboard[0] || {};
      const metricKey = (job.selected_metric || 'rmse').toLowerCase();
      document.getElementById('winner-metric-val').textContent = winnerRow[metricKey] !== undefined ? winnerRow[metricKey] : '-';

      const baselineRow = leaderboard.find(r => r.model_name === 'Seasonal Naive');
      let improvementText = '';
      if (baselineRow && winnerRow[metricKey] && baselineRow[metricKey] && winnerName !== 'Seasonal Naive') {
        const pctDiff = ((baselineRow[metricKey] - winnerRow[metricKey]) / baselineRow[metricKey] * 100).toFixed(1);
        improvementText = ` Outperformed Seasonal Naive baseline by ${pctDiff}%.`;
      }
      document.getElementById('winner-model-reason').textContent =
        `Selected as winning model with lowest holdout error (${metricKey.toUpperCase()}: ${winnerRow[metricKey] || '-'}; MASE: ${winnerRow.mase || '-'}).${improvementText}`;

      // Baseline Warning Banner
      const baselineWarningBanner = document.getElementById('baseline-warning-banner');
      const anyBeat = leaderboard.some(r => r.model_name !== 'Seasonal Naive' && r.beats_baseline);
      if (!anyBeat && leaderboard.length > 1) {
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
        if (isWinner) tr.style.background = 'rgba(2, 132, 199, 0.05)';

        const beatsBadge = r.status === 'ok'
          ? (r.beats_baseline
              ? '<span class="badge badge-teal" style="font-size: 0.72rem;">Yes</span>'
              : '<span class="badge" style="background: #fee2e2; color: #991b1b; font-size: 0.72rem;">No</span>')
          : '<span style="color: var(--color-text-subtle);">-</span>';

        const statusBadge = r.status === 'ok'
          ? (isWinner ? '<span class="badge badge-teal" style="font-weight: 700;">WINNER</span>' : '<span class="badge badge-navy">OK</span>')
          : `<span class="badge" style="background: #fef3c7; color: #92400e;">${r.status}</span>`;

        tr.innerHTML = `
          <td style="font-weight: 700; color: var(--color-primary);">${r.rank < 900 ? '#' + r.rank : '-'}</td>
          <td style="font-weight: ${isWinner ? '700' : '500'}; color: var(--color-primary);">${r.model_name}</td>
          <td>${r.rmse !== null ? r.rmse : '-'}</td>
          <td>${r.mae !== null ? r.mae : '-'}</td>
          <td>${r.mape !== null ? r.mape + '%' : '-'}</td>
          <td>${r.smape !== null ? r.smape + '%' : '-'}</td>
          <td>${r.mase !== null ? r.mase : '-'}</td>
          <td>${beatsBadge}</td>
          <td style="font-size: 0.8rem; color: var(--color-text-muted);">${r.train_seconds ? r.train_seconds + 's' : '-'}</td>
          <td>${statusBadge}</td>
        `;
        lTbody.appendChild(tr);
      });

      // 3. Render Chart.js Visualizations
      renderMainForecastChart(forecastDataRes);
      renderErrorComparisonChart(leaderboard);
      renderHoldoutComparisonChart(forecastDataRes);

      // 4. Decision Log Timeline
      renderAuditTimeline(auditActions);

      // 5. Projected Points Table
      renderForecastPointsTable(forecastDataRes.forecast || []);

      // 6. Download CSV Button
      const btnDownload = document.getElementById('btn-download-forecast-csv');
      btnDownload.href = `/api/agents/forecasting/jobs/${jobId}/download`;

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

    mainForecastChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: allDates,
        datasets: [
          {
            label: 'Historical Actual',
            data: historyData,
            borderColor: '#1a2332',
            backgroundColor: '#1a2332',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.1
          },
          {
            label: 'Projected Forecast',
            data: futureVals,
            borderColor: '#0284c7',
            backgroundColor: '#0284c7',
            borderWidth: 2.5,
            pointRadius: 3,
            tension: 0.1
          },
          {
            label: '95% Upper Bound',
            data: upper95,
            borderColor: 'rgba(2, 132, 199, 0.25)',
            borderWidth: 1,
            pointRadius: 0,
            fill: '+1',
            backgroundColor: 'rgba(2, 132, 199, 0.10)'
          },
          {
            label: '95% Lower Bound',
            data: lower95,
            borderColor: 'rgba(2, 132, 199, 0.25)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          },
          {
            label: '80% Interval Band',
            data: upper80,
            borderColor: 'rgba(13, 148, 136, 0.35)',
            borderWidth: 1,
            pointRadius: 0,
            fill: '+1',
            backgroundColor: 'rgba(13, 148, 136, 0.18)'
          },
          {
            label: '80% Lower Bound',
            data: lower80,
            borderColor: 'rgba(13, 148, 136, 0.35)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          }
        ]
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
              filter: (item) => !item.text.includes('Lower Bound')
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

  function renderErrorComparisonChart(leaderboard) {
    const ctx = document.getElementById('errorMetricsChart');
    if (!ctx) return;

    if (errorMetricsChartInstance) {
      errorMetricsChartInstance.destroy();
    }

    const validModels = leaderboard.filter(r => r.status === 'ok');
    const labels = validModels.map(r => r.model_name.replace(' (Exponential Smoothing)', ''));
    const rmseVals = validModels.map(r => r.rmse);
    const maeVals = validModels.map(r => r.mae);
    const smapeVals = validModels.map(r => r.smape);

    errorMetricsChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'RMSE',
            data: rmseVals,
            backgroundColor: '#0284c7'
          },
          {
            label: 'MAE',
            data: maeVals,
            backgroundColor: '#0d9488'
          },
          {
            label: 'sMAPE (%)',
            data: smapeVals,
            backgroundColor: '#f59e0b'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } }
        },
        scales: {
          x: { ticks: { font: { size: 9 }, maxRotation: 30 } },
          y: { grid: { color: 'rgba(226, 232, 240, 0.6)' }, ticks: { font: { size: 9 } } }
        }
      }
    });
  }

  function renderHoldoutComparisonChart(data) {
    const ctx = document.getElementById('holdoutComparisonChart');
    if (!ctx) return;

    if (holdoutChartInstance) {
      holdoutChartInstance.destroy();
    }

    const holdout = data.holdout || [];
    if (holdout.length === 0) return;

    const dates = holdout.map(h => h.date);
    const actualVals = holdout.map(h => h.actual);

    // Color palette for models
    const colors = ['#0284c7', '#0d9488', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'];

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
    modelCols.forEach((col, idx) => {
      const colData = holdout.map(h => h[col]);
      const colName = col.replace(/_/g, ' ').toUpperCase();
      datasets.push({
        label: colName,
        data: colData,
        borderColor: colors[idx % colors.length],
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
            <span class="step-chip">${act.step_name}</span>
            ${act.model_name ? `<span class="model-chip">${act.model_name}</span>` : ''}
          </div>
          <p class="audit-desc">${act.description}</p>
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

    points.forEach(pt => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 600; color: var(--color-primary);">${pt.forecast_date}</td>
        <td style="font-weight: 700; color: #0284c7;">${parseFloat(pt.forecast_value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
        <td>${pt.lower_80 !== null ? parseFloat(pt.lower_80).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
        <td>${pt.upper_80 !== null ? parseFloat(pt.upper_80).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
        <td>${pt.lower_95 !== null ? parseFloat(pt.lower_95).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
        <td>${pt.upper_95 !== null ? parseFloat(pt.upper_95).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '-'}</td>
      `;
      tbody.appendChild(tr);
    });
  }

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
