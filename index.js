const localenv = require('localenv')
const chalk = require('chalk')
const cheerio = require('cheerio')
const request = require('request-promise')
const R = require('ramda')
const Promise = require('bluebird')
const Trello = require('trello') // use fork
const trello = new Trello(process.env.TRELLO_API_KEY, process.env.TRELLO_USER_TOKEN)

const SPOILER_URL = 'http://www.magicspoiler.com/shadows-over-innistrad/'
const NEW_CARD_LIMIT = Infinity
const SCRAPE_CONCURRENCY = 50
const ADD_CONCURRENCY = 1

const dryRun = true // does not add cards to trello

const basicLands = {
  plains: 1,
  island: 1,
  swamp: 1,
  mountain: 1,
  forest: 1
}

const log = console.log
const error = R.pipe(chalk.red, console.error)

// remove the -216x302 from the given url to get the larger image
const getBigImageUrl = R.replace(/-\d+x\d+(?=\..{3}$)/, '')

// get the color of the pre-transformed card given a string like "White, Black" where
// the last given color is the pre-transformed color
const getTransformColor = R.useWith(R.slice, [
  R.identity,
  R.pipe(R.lastIndexOf(','), R.add(2))
])

// gets the intended list name for the card determined by its type and color
function getTargetListName(card) {
  return !card.color ? 'Unknown' :
    card.color === 'Colorless' ?
      (card.type.includes('Artifact') ? 'Artifact' : card.type.replace('Legendary ', '')) :
    R.contains(',', card.color) ? getTargetListName({
      color: getTransformColor(card.color),
      type: card.type.slice(0, card.type.indexOf(','))
    }) :
    card.color
}

// lowercase, trim, remove punctuation and extraneous whitespace from a given string
const makeLooselyComparable = R.pipe(
  R.trim,
  R.replace(/ {2,}/g, ' '),
  R.replace(/\W/g, ''),
  R.toLower()
)

const eqLoose = R.eqBy(makeLooselyComparable)

// a loose string contains that ignores case and extra whitespace
const containsLoose = R.useWith(R.any, [eqLoose, R.identity])

const isBasic = R.pipe(R.toLower, R.flip(R.has)(basicLands))

// gets all the spoiler cards from the given magicspoiler.com url
// recursively scrapes next pages
function getSpoilers(url) {

  log(`Fetching ${url}...`)

  return request(url).then(R.pipe(

    cheerio.load,
    $ => {

      // scrape the cards from the current page
      const cards = $('.spoiler-set-card > a')
        .map((i, el) => ({
          name: $(el).attr('title'),
          detailsUrl: $(el).attr('href'),
          imageUrl: getBigImageUrl($('img', el).attr('src'))
        }))
        .toArray()

      log(`Scraped ${cards.length} cards.`)

      // follow the next posts link
      const nextPostsUrl = $('.nextpostslink').attr('href')
      return nextPostsUrl ?
        // recursively get the spoilers from the next page and concatenate them with the current cards
        getSpoilers(nextPostsUrl).then(R.concat(cards)) :
        cards
    }
  ))
}

// scrapes the card details from the given details page url
function getDetails(url) {

  log(`Getting card details at ${url}...`)

  // parse a key-value pair from the given string
  function parsePair(str) {
    const colon = str.indexOf(':')
    return {
      key: str.slice(0, colon).trim(),
      value: str.slice(colon+1).trim()
    }
  }

  return request(url)
    .catch(e => {
      error(`Error fetching ${url}`)
      throw new Error(e)
    })
    .then(R.pipe(
      cheerio.load,
      $ => {
        const detailsRows = $('.card-type')
          .map((i, el) => $(el).text())
          .toArray()
          .map(parsePair)
        return R.reduce((result, next) => {
          result[next.key.toLowerCase()] = next.value.trim()
          return result
        }, {}, detailsRows)
      }
    ))
}

const lists = trello.getListsOnBoard(process.env.BOARD_ID)
const allCards = Promise.map(trello.getCardsOnBoard(process.env.BOARD_ID), R.prop('name'))
const spoilers = getSpoilers(SPOILER_URL)
  .then(R.reject(R.pipe(R.prop('name'), isBasic)))

const newCards = Promise.join(allCards, spoilers, (allCards, spoilers) => {
  // reject all spoilers that exist in allCards
  return R.reject(R.pipe(R.prop('name'), R.flip(containsLoose)(allCards)), spoilers)
})
.then(R.take(NEW_CARD_LIMIT))
.map(card => {
  return getDetails(card.detailsUrl).then(R.merge(card))
}, { concurrency: SCRAPE_CONCURRENCY })

// log some stuff
spoilers.tap(x => log(`${x.length} total spoilers found.`))
allCards.tap(x => log(`${x.length} cards on board.`))
newCards.tap(x => log(`${x.length} new cards found.`))

// add new cards to board
Promise.join(lists, newCards, (lists, cards) => {

  return Promise.map(cards, card => {

    // get the id of the list to add the card to
    const targetListName = getTargetListName(card)
    const list = lists.find(list => eqLoose(list.name, targetListName))

    log(`Adding ${card.name} to ${targetListName} list.`)

    if(!list) {
      throw new Error(`Could not find list "${targetListName}".`)
    }

    if(!dryRun) {
      return trello.addCard({
        name: card.name,
        idList: list.id,
        pos: 'top'
      }).then((trelloCard) => trello.addAttachmentToCard(trelloCard.id, card.imageUrl))
    }

  }, { concurrency: ADD_CONCURRENCY })
})
