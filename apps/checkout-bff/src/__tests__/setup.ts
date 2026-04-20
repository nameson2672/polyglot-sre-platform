// Set required environment variables before any module imports
process.env['ORDERS_API_URL'] = 'http://localhost:8080';
process.env['ORDERS_API_KEY'] = 'test-api-key';
process.env['JWT_SECRET'] = 'test-jwt-secret';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['APP_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'error';
