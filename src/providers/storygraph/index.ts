import { BaseProvider } from '../BaseProvider'
import { SeriesMetadata, BookMetadata, ParsedParameters, ProviderConfig } from '../../types'
import { normalizeBookMetadata } from '../../utils/helpers'
import { httpClient } from '../../utils/httpClient'
import { dbManager } from '../../database/manager'
import { StoryGraphSearchResult } from './types'
import fs from 'fs'
import path from 'path'
import * as cheerio from 'cheerio'

const configPath = path.join(__dirname, 'config.json')
const config: ProviderConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

export default class StoryGraphProvider extends BaseProvider {
  private readonly baseUrl = 'https://app.thestorygraph.com'
  private readonly searchUrl = `${this.baseUrl}/search`
  private readonly editionsUrl = `${this.baseUrl}/filter-editions`
  private sessionCookie: string | null = null

  constructor() {
    super(config)
  }

  private async getSessionCookie(): Promise<string> {
    if (this.sessionCookie) {
      return this.sessionCookie
    }
    const resp = await httpClient.get(this.baseUrl, {
      headers: {
        ...this.getHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          includeCookie: false
        }),
        'Upgrade-Insecure-Requests': '1'
      }
    })

    if (resp.status !== 200) {
      throw new Error(`Unable to initialize StoryGraph session: ${resp.status} ${resp.statusText}`)
    }

    const cookie = resp.headers['set-cookie']?.[0] || ''
    if (!cookie) {
      throw new Error('Unable to initialize StoryGraph session: no session cookie returned')
    }

    this.sessionCookie = cookie
    //console.log(`Fetched StoryGraph session cookie: ${cookie}`)
    return cookie
  }

  public async search(
    title: string,
    author: string | null,
    params: ParsedParameters,
    options?: { skipCache?: boolean }
  ): Promise<BookMetadata[]> {
    const bookLimit = (params['booklimit'] as number) || 3
    const editionLimit = (params['editionlimit'] as number) || 1
    const language = (params['lang'] as string) || 'all'
    const pubYear = (params['pubyear'] as string) || 'edition'

    this.validateParameters(title, author, bookLimit, editionLimit, language, pubYear)

    await this.getSessionCookie()

    const searchResults = await this.searchBooks(title, author, bookLimit)
    if (searchResults.length === 0) {
      return []
    }

    const editions = await this.fetchEditionsForBooks(
      searchResults.map((result) => result.bookId),
      editionLimit,
      language,
      pubYear
    )
    let allResults: BookMetadata[]
    if (editions.length > 0) {
      allResults = editions
    } else {
      allResults = searchResults.slice(0, bookLimit).map((match) => {
        const metadata = normalizeBookMetadata({
          title: match.title,
          author: match.author,
          cover: match.cover,
          poweredBy: 'StoryGraph'
        })
        metadata.bookId = match.bookId
        return metadata
      })
    }
    //TODO: fetch description for each bookId and add to metadata.description

    if (!options?.skipCache) {
      for (const result of allResults) {
        if (result.bookId) {
          dbManager.setBookCache(this.config.id, result.bookId, JSON.stringify(result))
        }
      }
    }

    return allResults
  }

  private async searchBooks(
    title: string,
    author: string | null,
    bookLimit: number
  ): Promise<StoryGraphSearchResult[]> {
    const searchString = `${title}${author ? ` ${author}` : ''}`

    const searchParams = new URLSearchParams({
      search_term: searchString
    })

    const searchUrl = `${this.searchUrl}?${searchParams.toString()}`
    //console.log(`Fetching StoryGraph search results from: ${searchUrl}`)

    const searchRes = await httpClient.get<string>(searchUrl, {
      headers: this.getHeaders({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      })
    })

    if (searchRes.status === 404) {
      console.warn(`No search results found for query: "${searchString}"`)
      return []
    }
    if (searchRes.status !== 200) {
      throw new Error(`Error while searching StoryGraph: ${searchRes.status}`)
    }

    //console.log(`Search results fetched successfully for query: "${searchString}"`)

    const searchResults: StoryGraphSearchResult[] = this.parseSearchResults(searchRes.data)
    return searchResults.slice(0, bookLimit)
  }

  private parseSearchResults(html: string): StoryGraphSearchResult[] {
    const $ = cheerio.load(html)
    const results: StoryGraphSearchResult[] = []

    $('a.book-list-option[href^="/books/"]').each((_, element) => {
      const link = $(element)
      const href = link.attr('href') || ''
      const title = link.find('h1 .list-option-text').first().text().trim()
      const author = link.find('h2.list-option-text').first().text().trim()
      const cover = link.find('img').first().attr('src')

      if (!title || !href) {
        return
      }

      const bookId = href.replace('/books/', '').trim()
      if (!bookId) {
        return
      }

      results.push({ title, author, cover, bookId } as StoryGraphSearchResult)
    })

    return results
  }

  private async fetchEditionsForBooks(
    bookIds: string[],
    editionLimit: number,
    language: string,
    pubYear: string
  ): Promise<BookMetadata[]> {
    const editions: BookMetadata[] = []

    for (const bookId of bookIds) {
      const searchParams = new URLSearchParams({
        book_id: bookId,
        format_audio: 'true',
        commit: 'Filter'
      })

      if (language != 'all') {
        searchParams.append('languages[]', language)
      }

      const editionsUrl = `${this.editionsUrl}?${searchParams.toString()}`
      //console.log(`Fetching editions for bookId ${bookId} from: ${editionsUrl}`)

      const searchRes = await httpClient.get<string>(editionsUrl, {
        headers: this.getHeaders({
          accept:
            'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01',
          referer: `${this.baseUrl}/books/${bookId}/editions`,
          xRequestedWith: true
        })
      })

      if (searchRes.status === 404) {
        console.warn(`No editions found for bookId: "${bookId}"`)
        continue
      }
      if (searchRes.status !== 200) {
        throw new Error(`Error while fetching editions from StoryGraph: ${searchRes.status}`)
      }

      const parsedEditions = this.parseFilteredEditionsResponse(searchRes.data, pubYear)
      if (parsedEditions.length > 0) {
        editions.push(...parsedEditions.slice(0, editionLimit))
      }

      //console.log(`Editions fetched successfully for bookId: "${bookId}"`)
    }

    return editions
  }

  private parseFilteredEditionsResponse(responseBody: string, pubYear: string): BookMetadata[] {
    if (typeof responseBody !== 'string' || responseBody.trim().length === 0) {
      return []
    }

    const htmlFragments: string[] = []
    const appendRegex = /\.append\("([\s\S]*?)"\)/g
    const replaceRegex = /\.replaceWith\("([\s\S]*?)"\)/g

    let match: RegExpExecArray | null
    while ((match = appendRegex.exec(responseBody)) !== null) {
      htmlFragments.push(this.decodeJsHtmlLiteral(match[1]))
    }
    while ((match = replaceRegex.exec(responseBody)) !== null) {
      htmlFragments.push(this.decodeJsHtmlLiteral(match[1]))
    }

    if (htmlFragments.length === 0) {
      return []
    }

    const $ = cheerio.load(`<div>${htmlFragments.join('\n')}</div>`)
    const results: BookMetadata[] = []
    const seenBookIds = new Set<string>()

    //extract metadata, all editions share, such as series, tags (pink) and genres (teal) from the first fragment and add to results
    const series: SeriesMetadata[] = []
    const $seriesLink = $('.book-title-author-and-series p.font-semibold a[href^="/series/"]').first()
    if ($seriesLink.length > 0) {
      const href = $seriesLink.attr('href') || ''
      const seriesName = $seriesLink.text().trim()
      if (href && seriesName) {
        const sequence = $seriesLink.next()?.text().trim() || undefined
        series.push({
          series: seriesName,
          sequence
        } as SeriesMetadata)
      }
    }
    const tags: string[] = []
    const genres: string[] = []
    $('.block.md\\:hidden.my-1.leading-4.w-\\[93\\%\\]')
      .first()
      .find('span')
      .each((_, element) => {
        const span = $(element)
        const text = span.text().trim()
        if (span.hasClass('text-teal-700') || span.hasClass('dark:text-teal-200')) {
          genres.push(text)
        } else if (span.hasClass('text-pink-500') || span.hasClass('dark:text-pink-200')) {
          tags.push(text)
        }
      })
    //extract edition specific metadata from each edition and add to results
    $('.book-pane').each((_, element) => {
      const pane = $(element)
      const bookId = String(pane.attr('data-book-id') || '').trim()
      if (!bookId || seenBookIds.has(bookId)) {
        return
      }

      const title = pane.find('h3 a[href^="/books/"]').first().text().trim()
      const author = pane.find('p.font-body a[href^="/authors/"]').first().text().trim()
      const cover = pane.find('.book-cover img').first().attr('src')
      const narratorNames = pane
        .find('.contributor-names a[href^="/authors/"]')
        .map((_, el) => $(el).text().trim())
        .get()
      const uniqueNarratorNames = [...new Set(narratorNames.filter((name) => name.length > 0))]
      const editionInfo = this.extractEditionInfo(pane, pubYear)
      const duration = this.extractDurationMinutes(
        pane.find('.toggle-edition-info-link').first().text().replace(/\s+/g, ' ').trim()
      )

      const normalized = normalizeBookMetadata({
        title,
        author: author,
        cover: cover,
        narrator: uniqueNarratorNames.length > 0 ? uniqueNarratorNames.join(', ') : undefined,
        duration,
        ...editionInfo,
        tags: tags.length > 0 ? tags : undefined,
        genres: genres.length > 0 ? genres : undefined,
        series: series.length > 0 ? series : undefined,
        poweredBy: 'StoryGraph'
      })
      normalized.bookId = bookId

      seenBookIds.add(bookId)
      results.push(normalized)
    })

    return results
  }

  private extractEditionInfo(pane: cheerio.Cheerio<any>, pubyear: string): Partial<BookMetadata> {
    const info: Partial<BookMetadata> = {}

    pane.find('.edition-info p').each((_, p) => {
      const label = pane.find(p).find('span').first().text().toLowerCase().replace(':', '').trim()
      const text = pane.find(p).text().replace(/\s+/g, ' ').trim()
      const value = text.replace(pane.find(p).find('span').first().text(), '').trim()

      if (!value || value.toLowerCase() === 'not specified' || value.toLowerCase() === 'none') {
        return
      }

      if (label.includes('isbn/uid')) {
        info.isbn = value
      } else if (label.includes('language')) {
        info.language = value
      } else if (pubyear === 'original' && label.includes('original pub year')) {
        info.publishedYear = value.match(/\d{4}/)?.[0]
      } else if (pubyear === 'edition' && label.includes('edition pub date')) {
        info.publishedYear = value.match(/\d{4}/)?.[0]
      } else if (label.includes('publisher')) {
        info.publisher = value
      }
    })

    return info
  }

  private extractDurationMinutes(durationText: string): number | undefined {
    if (!durationText) {
      return undefined
    }

    const hours = Number(durationText.match(/(\d+)\s*h/i)?.[1] || 0)
    const minutes = Number(durationText.match(/(\d+)\s*m/i)?.[1] || 0)
    const totalMinutes = hours * 60 + minutes
    return totalMinutes > 0 ? totalMinutes : undefined
  }

  private decodeJsHtmlLiteral(value: string): string {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\')
  }

  private validateParameters(
    title: string,
    author: string | null,
    booklimit: number,
    editionlimit: number,
    language: string,
    pubyear: string
  ): void {
    if (title.trim() === '') {
      throw new Error('Title is required')
    }

    this.validateLimit(booklimit, 'booklimit')
    this.validateLimit(editionlimit, 'editionlimit')

    if (booklimit * editionlimit > 10) {
      throw new Error('The product of booklimit and editionlimit may not exceed 10')
    }

    const langDef = this.getConfigParam('lang')
    if (language !== 'all' && langDef?.validation.values && !langDef.validation.values.includes(language)) {
      throw new Error(`Invalid language value: ${language}`)
    }

    const pubYearDef = this.getConfigParam('pubyear')
    if (pubyear !== 'edition' && pubYearDef?.validation.values && !pubYearDef.validation.values.includes(pubyear)) {
      throw new Error(`Invalid pubyear value: ${pubyear}`)
    }
  }

  private validateLimit(limit: number, name: string): void {
    const limitDef = this.getConfigParam(name)
    if (limitDef?.validation) {
      if (limit < (limitDef.validation.min ?? 1)) {
        throw new Error(`${name} must be >= ${limitDef.validation.min}`)
      }
      if (limit > (limitDef.validation.max ?? 20)) {
        throw new Error(`${name} must be <= ${limitDef.validation.max}`)
      }
    }
  }

  private getConfigParam(paramName: string) {
    const configParam = this.config.parameters.find((param) => param.name === paramName)
    return configParam
  }

  private getHeaders(options?: {
    accept?: string
    includeCookie?: boolean
    referer?: string
    xRequestedWith?: boolean
  }): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: options?.accept ?? 'application/json',
      'Accept-Encoding': 'gzip, deflate, br',
      Host: 'app.thestorygraph.com',
      'User-Agent': 'Mozilla/5.0 Gecko/20100101 Firefox/152.0',
      Cookie: options?.includeCookie === false ? '' : this.sessionCookie || '',
      Referer: options?.referer ?? 'https://app.thestorygraph.com/'
    }

    if (options?.xRequestedWith) {
      headers['X-Requested-With'] = 'XMLHttpRequest'
    }

    return headers
  }
}
