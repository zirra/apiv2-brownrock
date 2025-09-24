const { Sequelize, DataTypes } = require('sequelize')
const dotenv = require('dotenv')
dotenv.config()


const pgdbconnect = new Sequelize(
  process.env.PGDATABASE,
  process.env.PGUSER,
  process.env.PGPASSWORD,
  {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT || 5432,
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: {
        require: false,
        rejectUnauthorized: false // For RDS, this is typically needed
      }
    }
  }
)

const Contact = require('../models/contact.js');
Contact.init(pgdbconnect);

(async () => {
  try {
    await pgdbconnect.authenticate();
    console.log('Sequelize connected to Postgres');
    await pgdbconnect.sync({ alter: true });
    console.log('Database synced');
  } catch (err) {
    console.error('Database connection/sync error:', err);
  }
})();

module.exports = {
  pgdbconnect,
  Contact,
  DataTypes
}