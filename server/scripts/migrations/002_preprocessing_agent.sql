-- Migration: 002_preprocessing_agent.sql
-- Description: Adds tables for Data Preprocessing Agent jobs, processed datasets, and audit logs.

-- 1. Processing Jobs Table
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

-- 2. Processed Datasets Table
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

-- 3. Cleaning Actions / Audit Log Table
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

-- 4. Indexes for high-performance querying
CREATE INDEX IF NOT EXISTS idx_processing_jobs_user ON processing_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_dataset ON processing_jobs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_processed_datasets_job ON processed_datasets(job_id);
CREATE INDEX IF NOT EXISTS idx_processed_datasets_user ON processed_datasets(user_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_actions_job ON cleaning_actions(job_id);
