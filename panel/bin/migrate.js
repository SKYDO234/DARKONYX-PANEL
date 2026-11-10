#!/usr/bin/env node
const { initDatabase, query } = require('../src/database/db');
const { seedDatabase } = require('../src/database/seed');

async function migrate() {
  console.log('🔄 Running DARKONYX PANEL Database Migrations (MariaDB / MySQL)...');
  
  try {
    // 1. Initialize all core tables
    await initDatabase();
    
    // 2. Run importer & subdomains table initializations if not present
    await query.exec(`
      CREATE TABLE IF NOT EXISTS server_importer_profiles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(191) NOT NULL,
        host VARCHAR(191) NOT NULL,
        port INT DEFAULT 22,
        mode VARCHAR(50) DEFAULT 'sftp',
        username VARCHAR(191),
        remote_path VARCHAR(255) DEFAULT '/',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_importer_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS server_subdomains (
        id INT AUTO_INCREMENT PRIMARY KEY,
        server_id INT NOT NULL,
        subdomain VARCHAR(191) NOT NULL,
        domain VARCHAR(191) NOT NULL,
        full_domain VARCHAR(191) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_subdomains_server (server_id),
        CONSTRAINT fk_subdomains_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 3. Seed default tables if empty
    await seedDatabase();

    console.log('✨ All migrations and schema checks completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();

