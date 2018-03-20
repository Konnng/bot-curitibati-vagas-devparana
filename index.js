const Q = require('q')
const cheerio = require('cheerio')
const fs = require('fs-extra')
const path = require('path')
const request = require('request')
const moment = require('moment')
const lowDb = require('lowdb')
const lowDbStorage = require('lowdb/lib/storages/file-sync')
const objectMap = require('object.map')
const trim = require('trim')
const sleep = require('sleep-time')
const Slack = require('slack-node')

const slackWebHook = process.env.LABS_SLACK_WEBHOOK_URL_DEVPARANA_BOT_CURITIBA || ''
const dbFile = path.join(__dirname, 'data/db.json')

if (!fs.existsSync(path.dirname(dbFile)) && !fs.mkdirsSync(path.dirname(dbFile))) {
  throw new Error('Error creating data dir.')
} else if (!slackWebHook) {
  throw new Error('Slack Webhook not found in enviroment variables. Aborting...')
}

const db = lowDb(dbFile, { storage: lowDbStorage })

db.defaults({ jobs: [], settings: {} }).write()

// --------------------------------------------------------------------------ntand-----------------------

let slack = new Slack()
let deferred = Q.defer()
let deferredProcessing = Q.defer()
let deferredFinal = Q.defer()
let htmlFileTests = path.join(__dirname, 'jobs.html')
let sandBox = false
let httpClient = request.defaults({ jar: true })

slack.setWebhook(slackWebHook)

_log('Searching for new job offers...')

try {
  if (sandBox && fs.existsSync(htmlFileTests)) {
    deferred.resolve(fs.readFileSync(htmlFileTests))
  } else {
    httpClient('https://www.curitibati.com.br', (err, response, body) => {
      if (err) {
        return deferred.reject(err)
      } else if (response.statusCode !== 200) {
        return deferred.reject(`Error completing the resquest. Status Code => ${response.statusCode}`)
      }
      let $ = cheerio.load(body)
      let $form = $('.form-search-home')
      let urlSearch = `https://www.curitibati.com.br${$form.attr('action')}`
      // let urlSearch = $form.attr('action')
      let token = $form.find('input[name="__RequestVerificationToken"]').val()
      let postData = { '__RequestVerificationToken': token, Expressao: '' }

      httpClient.post(urlSearch, { form: postData }, function (err, response, body) {
        if (err) {
          return deferred.reject(err)
        } else if (response.statusCode !== 200) {
          return deferred.reject(`Error completing the resquest. Status Code => ${response.statusCode}`)
        }

        deferred.resolve(body)
      })
    })
  }

  Q.when(deferred.promise, html => {
    if (sandBox && !fs.existsSync(htmlFileTests)) {
      fs.writeFileSync(htmlFileTests, html, 'utf8')
    }

    let $ = cheerio.load(html)
    let jobsOffers = $('.container .vaga .item')
    if (!jobsOffers.length) {
      throw new Error('No Job vaccancies where found.')
    }

    jobsOffers = jobsOffers.map((index, element) => {
      let $element = $(element)

      let id = $element.find('.col-md-10 h3 a').attr('href').match(/detalhe\/(\d+)/i)[1] || false
      let url = 'https://www.curitibati.com.br' + $element.find('.col-md-10 h3 a').attr('href')
      let title = trim($element.find('.col-md-10 h3').text()).replace(/ \(.+\)$/ig, '')
      let company = trim($element.find('.col-md-10 h5 span').eq(0).text())
      let city = trim($element.find('.col-md-10 h5 span').eq(1).text())
      let description = trim($element.find('.col-md-10 p').text())
      let date = trim($element.find('.col-md-10 h5 span').eq(2).text()).replace('Publicada em ', '') + '-' + (new Date()).getFullYear()
      let dateProcessed = moment().unix()
      let botProcessed = false
      let botProcessedDate = null

      date = date.split('-')
      date[1] = _month2Number(date[1])
      date = date.reverse().join('-')
      date = moment(new Date(date)).unix().toString()

      return objectMap(
        { id, title, date, dateProcessed, city, company, description, url, botProcessed, botProcessedDate },
        val => val !== null && val.constructor === String ? trim(val) : val
      )
    }).get()

    deferredProcessing.resolve(jobsOffers)
  }, err => {
    _log('ERROR: ', err)
    throw err
  })

  Q.when(deferredProcessing.promise).then(jobs => {
    let jobsBaseID = db.get('jobs').value().map(item => item.id)

    jobs.filter(item => {
      return jobsBaseID.indexOf(item.id) < 0
    }).forEach(job => {
      db.get('jobs').push(job).write()
    })

    deferredFinal.resolve()
  })

  Q.when(deferredFinal.promise).then(() => {
    let jobs = Array.from(db.get('jobs').filter({ botProcessed: false }).sortBy('date').reverse().value())

    _log(`Found ${jobs.length} job offers.`)

    if (jobs.length) {
      _log('Processing items to send to slack...')
    } else {
      _log('No new jobs to send to slack...')
    }

    _log('-'.repeat(100))

    try {
      const mainTitle = (jobs.length > 1 ? 'Vagas de trabalho encontradas. ' : 'Vaga de trabalho encontrada.') + ' Confira!'
      const slackQueue = jobs.map((item, index) => {
        return () => new Promise((resolve, reject) => {
          _log('Processing item ' + (index + 1))

          const date = moment.unix(item.date).format('DD/MM/YYYY')
          const jobTitle = item.title.replace(new RegExp(item.city, 'ig'), '') + ` - ${item.city}`

          _log(item.title, date)
          _log('-'.repeat(100))

          let params = {
            text: (index === 0 ? mainTitle + '\n\n\n' : '') +
            `*${jobTitle}* - ${item.url}`
          }

          slack.webhook(params, (err, response) => {
            if (err) {
              return reject(err)
            }
            if (response.statusCode === 200) {
              _log('Done posting item ' + (index + 1))
              _log('-'.repeat(100))
              db.get('jobs').find({ id: item.id }).assign({ botProcessed: true, botProcessedDate: moment().unix() }).write()
              sleep(1000)

              resolve(index)
            } else {
              reject(new Error('Error processing item ' + (index + 1) + ': ' + response.statusCode + ': ' + response.statusMessage))
            }
          })
        })
      })

      Array.from(Array(slackQueue.length).keys()).reduce((promise, next) => {
        return promise.then(() => slackQueue[next]()).catch(err => { throw err })
      }, Promise.resolve())

    } catch (err) {
      _log('ERROR: ', err)
      _log('-'.repeat(100))
    }
  })
} catch (err) {
  _log('ERROR: ', err)
  _log('-'.repeat(100))
}

function _month2Number (month) {
  let months = {
    'jan': 1,
    'fev': 2,
    'mar': 3,
    'abr': 4,
    'mai': 5,
    'jun': 6,
    'jul': 7,
    'ago': 8,
    'set': 9,
    'out': 10,
    'nov': 11,
    'dez': 12
  }

  return months[month.toLowerCase()] || false
}

function _log () {
  console.log.apply(console, [].concat([`[${moment().format('DD/MM/YYYY HH:mm:ss')}] =>`], Array.from(arguments) || []))
}
