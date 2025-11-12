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
const ContactReady = require ('../models/contact-ready.js');

Contact.init(pgdbconnect);
ContactReady.init(pgdbconnect);

(async () => {
  try {
    await pgdbconnect.authenticate();
    console.log('Sequelize connected to Postgres');
    await pgdbconnect.sync({ alter: true, force: false });
    console.log('Database synced');

    // Debug: Check what attributes Sequelize knows about
    console.log('ContactReady model attributes:', Object.keys(ContactReady.rawAttributes));
    console.log('Contact model attributes:', Object.keys(Contact.rawAttributes));
  } catch (err) {
    console.error('Database connection/sync error:', err);
  }
})();

module.exports = {
  pgdbconnect,
  Contact,
  ContactReady,
  DataTypes
}