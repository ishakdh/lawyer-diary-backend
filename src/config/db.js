const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    }
    : {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

pool.on('connect', () => {
    console.log('Successfully connected to the PostgreSQL database.');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle database client', err);
    process.exit(-1);
});

// Automatically create the cases table if it does not exist
const initializeDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cases (
                id SERIAL PRIMARY KEY,
                chamber_owner_id VARCHAR(255) NOT NULL,
                case_number VARCHAR(100) NOT NULL,
                section VARCHAR(100),
                court_name VARCHAR(255) NOT NULL,
                client_name VARCHAR(255) NOT NULL,
                client_phone VARCHAR(50) NOT NULL,
                opponent_name VARCHAR(255),
                next_hearing_date TIMESTAMP,
                notes TEXT,
                is_closed BOOLEAN DEFAULT FALSE,
                close_reason TEXT,
                old_case_number VARCHAR(100),
                old_court_name VARCHAR(255),
                old_section VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Cases table verified/created successfully.');
    } catch (err) {
        console.error('Error creating cases table:', err.message);
    }
};

initializeDatabase();

module.exports = {
    query: (text, params) => pool.query(text, params),
};