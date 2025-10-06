const dotenv = require('dotenv');
dotenv.config()
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '250mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.raw({ limit: '250mb' }));
const port = process.env.PORT || 5151;

const xPolicy = (req, res, next) => {
  res.header ('Access-Control-Allow-Origin', '*')
  res.header ('Access-Control-Expose-Headers', 'ukey')
  res.header ('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.header ('Access-Control-Allow-Credentials', 'true')
  res.header ('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, token, X-CSRF-TOKEN, api-key, authorization, content-type, Bearer, ukey')
  next ()
}

app.use(xPolicy)

const loadControllers = () => {
  
  fs.readdirSync(`./controller`).forEach((file) => {
    console.log('Found file:', file)
    if(file.endsWith('.js')) {  // This is the correct way
      import(`./controller/${file}`)
        .then(obj => {
          console.log('Successfully loaded controller:', file)
          obj.controller(app)
        })
        .catch(err => console.log('Controller load error:', err))
    }
  })
  
}

// Add routes first, then load controllers
app.get('/health', (req,res) => {
  res.send('OK')
})

app.get('/v1/health', (req,res) => {
  const formatMemoryUsage = (data) => `${Math.round(data / 1024 / 1024 * 100) / 100} MB`
  const memoryData = process.memoryUsage()
  const memoryUsage = {
    apiversion: `${process.env.VERSION}`,
    rss: `${formatMemoryUsage(memoryData.rss)} -> Resident Set Size - total memory allocated for the process execution`,
    heapTotal: `${formatMemoryUsage(memoryData.heapTotal)} -> total size of the allocated heap`,
    heapUsed: `${formatMemoryUsage(memoryData.heapUsed)} -> actual memory used during the execution`,
    external: `${formatMemoryUsage(memoryData.external)} -> V8 external memory`,
  }
  res.status(200).send(memoryUsage)
})

// Debug route to show all registered routes
app.get('/v1/routes', (_req, res) => {
  const routes = []
  if (app._router && app._router.stack) {
    app._router.stack.forEach((middleware) => {
      if (middleware.route) {
        routes.push({
          path: middleware.route.path,
          methods: Object.keys(middleware.route.methods)
        })
      }
    })
  }
  res.json({ routes })
})

// Direct test route for PostgreSQL (bypassing controller loading issues)
app.get('/v1/test-postgres-direct', async (_req, res) => {
  try {
    console.log('🧪 Direct PostgreSQL test...')
    const PostgresContactService = require('./services/postgres-contact.service.js')
    const pgService = new PostgresContactService()
    const result = await pgService.testConnection()
    res.json(result)
  } catch (error) {
    console.error('Direct test error:', error)
    res.status(500).json({
      success: false,
      message: error.message,
      stack: error.stack
    })
  }
})

// Direct route for getting PostgreSQL contacts
app.get('/v1/postgres-contacts-direct', async (req, res) => {
  try {
    const PostgresContactService = require('./services/postgres-contact.service.js')
    const pgService = new PostgresContactService()

    const {
      limit = 25,
      offset = 0,
      name,
      company,
      acknowledged,
      islegal,
      city,
      state
    } = req.query

    const result = await pgService.searchContacts({
      limit: parseInt(limit),
      offset: parseInt(offset),
      name,
      company,
      acknowledged: acknowledged !== undefined ? acknowledged === 'true' : undefined,
      islegal: islegal !== undefined ? islegal === 'true' : undefined,
      city,
      state
    })

    res.json(result)
  } catch (error) {
    console.error('Direct contacts error:', error)
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
})

// Load controllers after defining base routes
loadControllers()

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
});