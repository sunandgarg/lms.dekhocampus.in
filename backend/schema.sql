CREATE TABLE IF NOT EXISTS lms_users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role ENUM('super_admin', 'admin', 'user') NOT NULL DEFAULT 'user',
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_sign_in_at TIMESTAMP(3) NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lms_sessions (
  token_hash BINARY(32) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX sessions_user (user_id),
  INDEX sessions_expiry (expires_at),
  FOREIGN KEY (user_id) REFERENCES lms_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lms_records (
  collection VARCHAR(64) NOT NULL,
  id CHAR(36) NOT NULL,
  data JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  record_university_id VARCHAR(36) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.university_id'))) VIRTUAL,
  record_batch_id VARCHAR(36) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.batch_id'))) VIRTUAL,
  record_user_id VARCHAR(36) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.user_id'))) VIRTUAL,
  record_status VARCHAR(32) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.status'))) VIRTUAL,
  record_email VARCHAR(254) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.email'))) VIRTUAL,
  record_mobile VARCHAR(32) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.mobile'))) VIRTUAL,
  PRIMARY KEY (collection, id),
  INDEX records_created (collection, created_at),
  INDEX records_university (collection, record_university_id, created_at),
  INDEX records_batch (collection, record_batch_id, created_at),
  INDEX records_user (collection, record_user_id, created_at),
  INDEX records_status (collection, record_status, created_at),
  INDEX records_email (collection, record_email),
  INDEX records_mobile (collection, record_mobile)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lms_transactions (
  id CHAR(36) PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  university_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  request_key VARCHAR(255) NOT NULL,
  response_key VARCHAR(255),
  status VARCHAR(32) NOT NULL,
  http_status SMALLINT UNSIGNED,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX transactions_batch (batch_id, created_at),
  INDEX transactions_university (university_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lms_crm_mobile (
  mobile VARCHAR(32) PRIMARY KEY,
  contact_id CHAR(36) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lms_lead_queue (
  batch_id CHAR(36) NOT NULL,
  lead_index INT UNSIGNED NOT NULL,
  task JSON NOT NULL,
  status ENUM('queued', 'processing', 'done', 'needs_review') NOT NULL DEFAULT 'queued',
  error VARCHAR(1000),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (batch_id, lead_index),
  INDEX queue_next (status, created_at)
) ENGINE=InnoDB;
