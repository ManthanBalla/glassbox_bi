-- PostgreSQL Schema for GlassBox-BI

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    auth_provider VARCHAR(50) DEFAULT 'local',
    google_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS uploaded_datasets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(100) NOT NULL,
    file_size BIGINT NOT NULL,
    storage_path TEXT NOT NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'ready'
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_reset_token ON password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_datasets_user ON uploaded_datasets(user_id);

-- Preprocessing Agent Tables
CREATE TABLE IF NOT EXISTS processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dataset_id INTEGER NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'queued',
    config_json JSONB,
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_datasets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_dataset_id INTEGER NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    rows_before INTEGER,
    rows_after INTEGER,
    columns_before INTEGER,
    columns_after INTEGER,
    date_column VARCHAR(255),
    target_column VARCHAR(255),
    frequency VARCHAR(50),
    quality_score_before NUMERIC(5,2),
    quality_score_after NUMERIC(5,2),
    readiness_score NUMERIC(5,2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cleaning_actions (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
    step_order INTEGER,
    step_name VARCHAR(100),
    column_name VARCHAR(255),
    action VARCHAR(100),
    method VARCHAR(100),
    rows_affected INTEGER,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processing_jobs_user ON processing_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_dataset ON processing_jobs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_processed_datasets_job ON processed_datasets(job_id);
CREATE INDEX IF NOT EXISTS idx_processed_datasets_user ON processed_datasets(user_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_actions_job ON cleaning_actions(job_id);

-- Forecasting Agent Tables
CREATE TABLE IF NOT EXISTS forecast_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    processed_dataset_id UUID NOT NULL REFERENCES processed_datasets(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'queued',
    config_json JSONB,
    horizon INTEGER,
    selected_metric VARCHAR(50),
    winner_model VARCHAR(100),
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forecast_model_results (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES forecast_jobs(id) ON DELETE CASCADE,
    model_name VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL,
    skip_reason TEXT,
    mae NUMERIC(14,4),
    rmse NUMERIC(14,4),
    mape NUMERIC(10,4),
    smape NUMERIC(10,4),
    mase NUMERIC(10,4),
    beats_baseline BOOLEAN,
    rank INTEGER,
    hyperparameters_json JSONB,
    train_seconds NUMERIC(8,3),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forecast_points (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES forecast_jobs(id) ON DELETE CASCADE,
    forecast_date VARCHAR(50) NOT NULL,
    forecast_value NUMERIC(16,4) NOT NULL,
    lower_80 NUMERIC(16,4),
    upper_80 NUMERIC(16,4),
    lower_95 NUMERIC(16,4),
    upper_95 NUMERIC(16,4)
);

CREATE TABLE IF NOT EXISTS forecast_actions (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES forecast_jobs(id) ON DELETE CASCADE,
    step_order INTEGER,
    step_name VARCHAR(100),
    model_name VARCHAR(100),
    action VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_forecast_jobs_user ON forecast_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_forecast_jobs_dataset ON forecast_jobs(processed_dataset_id);
CREATE INDEX IF NOT EXISTS idx_forecast_model_results_job ON forecast_model_results(job_id);
CREATE INDEX IF NOT EXISTS idx_forecast_points_job ON forecast_points(job_id);
CREATE INDEX IF NOT EXISTS idx_forecast_actions_job ON forecast_actions(job_id);


