const jwt = require ('jsonwebtoken')

const authenticateJWT = (req, res, next) => {
  console.log('something')
  let token = false
  try {
    const result = req.headers.authorization
    let bearer = result.split(' ')
    token = bearer[1]
  } catch {
    token = false
  }
  if (token) {
    jwt.verify(token, process.env.HASH, (err, user) => {
      if(err) {
        res.sendStatus(403)
      } else {
        req.user = user
        next()
      }
    })
  } else {
    res.sendStatus(401)
  }
}

module.exports = authenticateJWT 