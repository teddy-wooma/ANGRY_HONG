const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const os                                = require('os')
const path                              = require('path')
const semver                            = require('semver')
const { spawn }                         = require('child_process')
const { Readable, Transform }           = require('stream')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const crypto                            = require('crypto')
const LangLoader                        = require('./app/assets/js/langloader')
const NbtUtil                           = require('./app/assets/js/nbtutil')
const { createMacUpdater }              = require('./app/assets/js/macupdater')
const macUpdater                        = createMacUpdater({ app, shell })

LangLoader.setupLanguage()

function initAutoUpdater(event, data) {

    if(data){
        autoUpdater.allowPrerelease = true
    } else {
                                                    }

                                                    if(isDev){
                                                        autoUpdater.autoInstallOnAppQuit = false
                                                        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
                                                    }
                                                    if(process.platform === 'darwin'){
                                                        // The custom DMG updater owns both checking and installation on macOS.
        return
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    }) 
}

ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkMacUpdate':
            macUpdater.check(event.sender)
            break
        case 'checkForUpdate':
            if(process.platform === 'darwin'){
                // macOS 에서는 서명 문제로 electron-updater 확인이 실패할 수 있습니다.
                macUpdater.check(event.sender)
                break
            }
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            if(!data){
                const preRelComp = semver.prerelease(app.getVersion())
                if(preRelComp != null && preRelComp.length > 0){
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            if(process.platform === 'darwin'){
                // 서명이 없어 electron-updater 로는 설치할 수 없습니다.
                macUpdater.install(event.sender)
            } else {
                autoUpdater.quitAndInstall()
            }
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})
// 배포 인덱스는 preloader 가 렌더러 스크립트보다 먼저 끝나므로, 렌더러가 'dom-ready' 를 알리기 전까지
// 결과를 큐에 쌓아 둡니다. 그대로 보내면 메시지가 사라져 로딩 화면에서 멈춥니다.
const rendererDomReady = new WeakSet()
const pendingDistributionIndex = new WeakMap()

function sendDistributionIndexDone(webContents, res) {
    if (webContents.isDestroyed()) {
        return
    }
    webContents.send('distributionIndexDone', res === true)
}

function flushDistributionIndexDone(webContents) {
    if (!pendingDistributionIndex.has(webContents)) {
        return
    }
    const res = pendingDistributionIndex.get(webContents)
    pendingDistributionIndex.delete(webContents)
    sendDistributionIndexDone(webContents, res)
}

ipcMain.on('distributionIndexDone', (event, res) => {
    const webContents = event.sender
    if (rendererDomReady.has(webContents)) {
        sendDistributionIndexDone(webContents, res)
    } else {
        pendingDistributionIndex.set(webContents, res === true)
    }
})

ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Windows 에서는 shell.openExternal 이 아무것도 열지 않고 성공하는 경우가 있어 cmd /c start 를 먼저 시도합니다.
function openExternalUrl(url) {
    if(process.platform === 'win32'){
        try {
            const child = spawn('cmd', ['/c', 'start', '', url], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            })
            child.unref()
            return
        } catch (err) {
            console.error('[Links] cmd start 실패, shell.openExternal 로 재시도합니다.', err)
        }
    }
    shell.openExternal(url).catch(err => {
        console.error('[Links] 브라우저를 열지 못했습니다:', url, err)
    })
}

ipcMain.handle('openExternal', (event, url) => {
    if(typeof url !== 'string' || !/^https?:\/\//i.test(url)){
        console.error('[Links] 허용되지 않은 URL 입니다:', url)
        return false
    }
    openExternalUrl(url)
    return true
})

// 렌더러는 file:// 로 돌고 커뮤니티 사이트는 CORS 헤더를 보내지 않아, 메인 프로세스에서 대신 받아옵니다.
async function fetchNewsPage(url) {
    const response = await fetch(url, {
        headers: {
            'user-agent': `BarkanLauncher/${app.getVersion()}`,
            accept: 'text/html,application/xhtml+xml'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }
    return await response.text()
}

ipcMain.handle('fetchNews', (event, url) => {
    if(typeof url !== 'string' || !/^https?:\/\//i.test(url)){
        return Promise.reject(new Error(`허용되지 않은 주소입니다: ${url}`))
    }
    return fetchNewsPage(url)
})

// preload 는 @electron/remote 가 준비되기 전에 돌아 ConfigManager 를 쓸 수 없고, 언어는 EJS 렌더링 전에 정해져야 하므로 config.json 을 직접 읽습니다.
function readConfiguredLanguage() {
    const candidates = [
        path.join(app.getPath('userData'), 'config.json'),
        path.join(app.getPath('appData'), '.barkanlauncher', 'config.json')
    ]
    for(const candidate of candidates){
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
            const value = parsed?.settings?.launcher?.language
            if(typeof value === 'string' && value.length > 0){
                return value
            }
        } catch (err) {
        }
    }
    return 'ko_KR'
}

ipcMain.on('getLanguage', (event) => {
    event.returnValue = readConfiguredLanguage()
})

// webContents.reload 로는 EJS 문구가 그대로 남고 앱 재시작은 돌아오지 않는 경우가 있어, loadURL 로 다시 그리고 메인 쪽 언어도 다시 읽습니다.
ipcMain.on('rerenderWindow', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if(win == null){
        return
    }
    LangLoader.setupLanguage()
    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())
})

const RESOURCE_PACK_STATE_FILE_PREFIX = '.barkan-file-'

async function fileSizeIfExists(target) {
    try {
        const stats = await fs.promises.stat(target)
        return stats.isFile() ? stats.size : null
    } catch (err) {
        return null
    }
}

async function readJsonIfExists(target) {
    try {
        return JSON.parse(await fs.promises.readFile(target, 'utf8'))
    } catch (err) {
        return null
    }
}

// releases/latest/download 는 releases/download/<태그>/... 로 리다이렉트되므로 그 주소에서 태그를 읽습니다. (GitHub API 요청 제한 없음)
async function resolveLatestRelease(url) {
    const manual = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(15000)
    })

    let version = null
    const location = manual.headers.get('location')
    if(location){
        const match = /\/releases\/download\/([^/]+)\//.exec(location)
        if(match){
            version = decodeURIComponent(match[1])
        }
    }

    if(manual.status >= 200 && manual.status < 300){
        return {
            version,
            size: Number(manual.headers.get('content-length') || 0),
            etag: manual.headers.get('etag') || null
        }
    }

    const followed = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(15000)
    })
    if(!followed.ok){
        throw new Error(`HTTP ${followed.status}`)
    }
    return {
        version,
        size: Number(followed.headers.get('content-length') || 0),
        etag: followed.headers.get('etag') || null
    }
}

async function downloadToFile(url, destination, onProgress, expectedSha1) {
    const logStart = Date.now()
    launchLog('DOWNLOAD', '시작 : ' + url)
    launchLog('DOWNLOAD', '  → 저장 : ' + destination)
    if (expectedSha1) { launchLog('DOWNLOAD', '  → 기대 sha1 : ' + expectedSha1) }
    const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(30 * 60 * 1000)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }

    const total = Number(response.headers.get('content-length') || 0)
    let received = 0
    let lastReport = 0
    const hash = expectedSha1 ? crypto.createHash('sha1') : null
    const counter = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length
            if(hash != null){
                hash.update(chunk)
            }
            if(onProgress && (received - lastReport > 512 * 1024 || received === total)){
                lastReport = received
                onProgress(received, total)
            }
            callback(null, chunk)
        }
    })

    launchLog('DOWNLOAD', '  → 완료 : ' + received + 'B / ' + total + 'B  (' + ((Date.now() - logStart) / 1000).toFixed(1) + '초)')
    const { pipeline } = require('stream/promises')
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destination))

    const sha1 = hash != null ? hash.digest('hex') : null
    if(expectedSha1 && sha1 !== String(expectedSha1).toLowerCase()){
        throw new Error(`SHA1 이 다릅니다 (받은 ${sha1} / 예상 ${expectedSha1})`)
    }

    return { size: received, total, etag: response.headers.get('etag') || null, sha1 }
}

// 매니페스트와 SHA1 이 같으면 건너뛰고, zip 을 풀거나 다시 압축하지 않습니다. (그러면 SHA1 이 달라집니다)
ipcMain.handle('syncServerResourcePack', async (event, options) => {
    launchLogSection('서버 리소스팩 동기화')
    launchLog('RSPACK', '요청 : ' + JSON.stringify(options))
    const { directory, manifestUrl, fileName } = options || {}

    if(typeof directory !== 'string' || directory.length === 0){
        return { status: 'failed', reason: '게임 폴더를 알 수 없습니다.' }
    }
    if(typeof manifestUrl !== 'string' || !/^https:\/\//i.test(manifestUrl)){
        return { status: 'failed', reason: `허용되지 않은 매니페스트 주소입니다: ${manifestUrl}` }
    }

    const safeName = path.basename(fileName || 'barkan-resourcepack.zip')
    const packDir = path.join(directory, 'resourcepacks')
    const target = path.join(packDir, safeName)
    const statePath = path.join(packDir, `${RESOURCE_PACK_STATE_FILE_PREFIX}${safeName}.json`)

    try {
        await fs.promises.mkdir(packDir, { recursive: true })

        const manifest = await fetchJson(manifestUrl, 20000)
        const sha1 = String(manifest.sha1 || '').toLowerCase()
        const url = String(manifest.url || '')
        const expectedSize = Number(manifest.size || 0)

        if(!/^[0-9a-f]{40}$/.test(sha1)){
            throw new Error(`매니페스트의 SHA1 이 올바르지 않습니다: ${manifest.sha1}`)
        }
        if(!/^https:\/\//i.test(url)){
            throw new Error(`매니페스트의 주소가 올바르지 않습니다: ${manifest.url}`)
        }

        const installedSize = await fileSizeIfExists(target)
        const state = await readJsonIfExists(statePath)

        if(installedSize != null && installedSize > 0 && state != null
            && String(state.sha1 || '').toLowerCase() === sha1
            && (expectedSize === 0 || installedSize === expectedSize)){
            console.log(`[ResourcePack] 이미 최신입니다: ${sha1.slice(0, 12)}…`)
            return { status: 'skipped', size: installedSize, sha1, version: sha1 }
        }

        const previousName = state != null && typeof state.fileName === 'string'
            ? path.basename(state.fileName)
            : null
        if(previousName != null && previousName !== safeName){
            await fs.promises.rm(path.join(packDir, previousName), { force: true })
        }
        await fs.promises.rm(target, { force: true })
        await fs.promises.rm(statePath, { force: true })

        const temp = `${target}.part`
        console.log(`[ResourcePack] 내려받는 중: ${safeName} (${(expectedSize / 1048576).toFixed(1)} MB)`)
        const result = await downloadToFile(url, temp, (received, total) => {
            if(!event.sender.isDestroyed()){
                event.sender.send('resourcePackProgress', { received, total })
            }
        }, sha1)

        await fs.promises.rename(temp, target)
        await fs.promises.writeFile(statePath, JSON.stringify({
            url,
            fileName: safeName,
            sha1,
            size: result.size,
            publishedAt: manifest.published_at || null,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8')

        console.log(`[ResourcePack] 설치 완료: ${safeName} sha1=${sha1.slice(0, 12)}… (${(result.size / 1048576).toFixed(1)} MB)`)
        return { status: 'installed', size: result.size, sha1, version: sha1 }
    } catch (err) {
        console.warn('[ResourcePack] 내려받지 못했습니다:', err.message)
        try {
            await fs.promises.rm(`${target}.part`, { force: true })
        } catch (cleanupErr) {  }

        const existing = await fileSizeIfExists(target)
        return existing != null
            ? { status: 'kept', size: existing, reason: err.message }
            : { status: 'failed', reason: err.message }
    }
})

ipcMain.handle('syncResourcePack', async (event, options) => {
    launchLogSection('리소스팩 동기화')
    launchLog('RSPACK', '요청 : ' + JSON.stringify(options))
    const { url, directory, subdirectory, fileName } = options || {}

    if(typeof url !== 'string' || !/^https:\/\//i.test(url)){
        return { status: 'failed', reason: `허용되지 않은 주소입니다: ${url}` }
    }
    if(typeof directory !== 'string' || typeof fileName !== 'string'){
        return { status: 'failed', reason: '저장 위치가 올바르지 않습니다.' }
    }

    const safeName = path.basename(fileName)
    const safeFolder = path.basename(subdirectory || 'resourcepacks')
    const packDir = path.join(directory, safeFolder)
    const target = path.join(packDir, safeName)
    const statePath = path.join(packDir, `${RESOURCE_PACK_STATE_FILE_PREFIX}${safeName}.json`)

    try {
        await fs.promises.mkdir(packDir, { recursive: true })

        let latest = null
        try {
            latest = await resolveLatestRelease(url)
        } catch (err) {
            console.warn('[ResourcePack] 최신 정보를 확인하지 못했습니다:', err.message)
        }

        const installedSize = await fileSizeIfExists(target)
        const installed = installedSize != null && installedSize > 0
        const state = await readJsonIfExists(statePath)
        const havePack = installed

        const upToDate = latest != null && havePack && (
            (latest.version != null && state != null && state.version === latest.version &&
                (latest.size === 0 || installedSize === latest.size)) ||
            (latest.version == null && latest.size > 0 && installedSize === latest.size)
        )

        if(upToDate){
            console.log(`[ResourcePack] 이미 최신입니다: ${latest.version || '(태그 없음)'}`)
            return { status: 'skipped', size: installedSize, version: latest.version }
        }

        if(latest == null && havePack){
            console.log('[ResourcePack] 최신 버전을 확인할 수 없어 가진 팩을 그대로 사용합니다.')
            return { status: 'kept', size: installedSize, reason: '최신 버전을 확인하지 못했습니다.' }
        }

        if(havePack){
            console.log(`[ResourcePack] 새 버전을 발견해 교체합니다: ${state && state.version ? state.version : '알 수 없음'} -> ${latest && latest.version ? latest.version : '알 수 없음'}`)
            await fs.promises.rm(target, { force: true })
        }
        await fs.promises.rm(statePath, { force: true })

        const temp = `${target}.part`
        console.log(`[ResourcePack] 내려받는 중: ${safeName}`)
        const result = await downloadToFile(url, temp, (received, total) => {
            if(!event.sender.isDestroyed()){
                event.sender.send('resourcePackProgress', { received, total })
            }
        })

        if(latest != null && latest.size > 0 && result.size !== latest.size){
            throw new Error(`크기가 다릅니다 (받은 ${result.size} / 예상 ${latest.size})`)
        }

        await fs.promises.rename(temp, target)
        await fs.promises.writeFile(statePath, JSON.stringify({
            url,
            fileName: safeName,
            version: latest ? latest.version : null,
            size: result.size,
            etag: result.etag,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8')

        console.log(`[ResourcePack] 설치 완료: ${safeName} ${latest && latest.version ? latest.version : ''} (${(result.size / 1048576).toFixed(1)} MB)`)
        return { status: 'installed', size: result.size, version: latest ? latest.version : null }
    } catch (err) {
        console.warn('[ResourcePack] 내려받지 못했습니다:', err.message)
        try {
            await fs.promises.rm(`${target}.part`, { force: true })
        } catch (cleanupErr) {  }

        const existing = await fileSizeIfExists(target)
        return existing != null
            ? { status: 'kept', size: existing, reason: err.message }
            : { status: 'failed', reason: err.message }
    }
})

app.disableHardwareAcceleration()


const MOD_LIST_URL = 'https://raw.githubusercontent.com/teddy-wooma/FISH_MOD_LIST/refs/heads/main/mods.json'
const MODRINTH_API = 'https://api.modrinth.com/v2'
const MOD_LOADER = 'fabric'
const MOD_GAME_VERSION = '1.21.11'
const MOD_STATE_FILE_PREFIX = '.barkan-mod-'
// 모드를 끄면 파일을 지우지 않고 이 폴더로 옮깁니다. (지웠다 다시 받으면 그 모드가 쓰던 설정이 사라집니다)
const MOD_DISABLED_DIR = 'mods-disabled'

async function fetchJson(url, timeoutMs = 15000) {
    const response = await fetch(url, {
        headers: {
            'user-agent': `BarkanLauncher/${app.getVersion()}`,
            accept: 'application/json'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }
    return JSON.parse(await response.text())
}

function modrinthSlug(url) {
    const match = /modrinth\.com\/mod\/([^/?#]+)/i.exec(String(url || ''))
    return match ? match[1] : null
}

async function resolveModrinthVersion(slug) {
    const base = `loaders=${encodeURIComponent(JSON.stringify([MOD_LOADER]))}`
        + `&game_versions=${encodeURIComponent(JSON.stringify([MOD_GAME_VERSION]))}`

    // 릴리즈를 먼저 찾고, 없으면 베타를 씁니다.
    // 나중에 릴리즈가 나오면 버전 번호가 달라지므로 자동으로 갈아탑니다.
    for(const channel of ['release', 'beta']){
        const list = await fetchJson(
            `${MODRINTH_API}/project/${encodeURIComponent(slug)}/version?${base}&version_type=${channel}`
        )
        if(!Array.isArray(list) || list.length === 0){
            continue
        }

        const version = list[0]
        const files = Array.isArray(version.files) ? version.files : []
        const file = files.find(f => f.primary === true) || files[0]
        if(file == null || !file.url){
            continue
        }

        return {
            version: String(version.version_number || ''),
            fileName: path.basename(file.filename),
            url: file.url,
            size: Number(file.size || 0),
            channel
        }
    }

    return null
}

async function ensureServerEntry(directory, address, quickPlayAddress) {
    if(typeof directory !== 'string' || directory.length === 0){
        return false
    }
    if(typeof address !== 'string' || address.length === 0){
        return false
    }

    const target = path.join(directory, 'servers.dat')
    let current = null
    try {
        current = await fs.promises.readFile(target)
    } catch (err) {
        current = null
    }

    const updated = NbtUtil.ensureServer(current, {
        name: '바르칸 열도',
        ip: address,
        quickPlayAddress
    })
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.writeFile(target, updated)
    return true
}

async function fetchModList() {
    const parsed = await fetchJson(MOD_LIST_URL)
    const pick = list => (Array.isArray(list) ? list : [])
        .filter(m => m != null && typeof m.url === 'string' && m.url.length > 0)
        .map(m => ({ name: String(m.name || m.url), url: m.url }))

    return { required: pick(parsed.required), optional: pick(parsed.optional) }
}

function directJarUrl(url) {
    const text = String(url || '')
    const blob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(text)
    if(blob != null){
        return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`
    }
    return /^https?:\/\//i.test(text) ? text : null
}

function modStateKey(url) {
    const slug = modrinthSlug(url)
    if(slug != null){
        return slug
    }
    const direct = directJarUrl(url)
    if(direct == null){
        return null
    }
    const name = decodeURIComponent(direct.split('/').pop() || '')
    return name.length > 0 ? name.replace(/[^0-9A-Za-z._-]/g, '_') : null
}

async function resolveModTarget(url) {
    const slug = modrinthSlug(url)
    if(slug != null){
        return await resolveModrinthVersion(slug)
    }

    const direct = directJarUrl(url)
    if(direct == null){
        return null
    }

    const response = await fetch(direct, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(15000)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }

    const fileName = decodeURIComponent((new URL(response.url).pathname.split('/').pop()) || '')
    if(fileName.length === 0){
        throw new Error('파일 이름을 알 수 없습니다.')
    }

    const etag = response.headers.get('etag') || response.headers.get('last-modified') || ''
    const size = Number(response.headers.get('content-length') || 0)

    return {
        version: etag.length > 0 ? etag : `size:${size}`,
        fileName: path.basename(fileName),
        url: direct,
        size
    }
}

async function moveFileIfExists(from, to) {
    if(await fileSizeIfExists(from) == null){
        return false
    }
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    await fs.promises.rm(to, { force: true })
    await fs.promises.rename(from, to)
    return true
}

async function writeModState(statePath, data) {
    await fs.promises.writeFile(statePath, JSON.stringify(data, null, 2), 'utf8')
}

ipcMain.handle('syncMods', async (event, options) => {
    launchLogSection('모드 동기화')
    launchLog('MODS', '요청 : ' + JSON.stringify(options))
    const { directory, disabledUrls, serverAddress, quickPlayAddress } = options || {}
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.', items: [] }
    }

    const disabled = new Set(Array.isArray(disabledUrls) ? disabledUrls : [])

    let list
    try {
        list = await fetchModList()
    } catch (err) {
        return {
            ok: false,
            items: [],
            reason: `모드 목록을 받아오지 못했습니다. (${err.message})\n인터넷 연결을 확인해 주세요.`
        }
    }

    const modsDir = path.join(directory, 'mods')
    const disabledDir = path.join(directory, MOD_DISABLED_DIR)
    await fs.promises.mkdir(modsDir, { recursive: true })

    const wanted = [
        ...list.required.map(m => ({ ...m, required: true })),
        ...list.optional.map(m => ({ ...m, required: false }))
    ]

    const items = []
    const failures = []

    for(const mod of wanted){
        const slug = modStateKey(mod.url)
        const enabled = !disabled.has(mod.url)
        const item = { name: mod.name, url: mod.url, slug, required: mod.required, enabled, status: 'failed' }

        try {
            if(slug == null){
                throw new Error('지원하지 않는 주소입니다. (모드린스 주소 또는 jar 주소)')
            }

            const info = await resolveModTarget(mod.url)
            if(info == null){
                throw new Error(`${MOD_GAME_VERSION} + ${MOD_LOADER} 버전을 찾지 못했습니다.`)
            }
            item.latestVersion = info.version

            const statePath = path.join(modsDir, `${MOD_STATE_FILE_PREFIX}${slug}.json`)
            const state = await readJsonIfExists(statePath)
            const fileName = state != null && typeof state.fileName === 'string'
                ? path.basename(state.fileName)
                : info.fileName
            item.fileName = fileName
            item.version = state != null ? (state.version || null) : null

            const inMods = (await fileSizeIfExists(path.join(modsDir, fileName))) != null
            const inDisabled = (await fileSizeIfExists(path.join(disabledDir, fileName))) != null

            if(!enabled){
                if(inMods){
                    await moveFileIfExists(path.join(modsDir, fileName), path.join(disabledDir, fileName))
                }
                item.status = 'disabled'
                items.push(item)
                continue
            }

            if(!inMods && !inDisabled){
                await fs.promises.rm(path.join(modsDir, info.fileName), { force: true })
                await downloadToFile(info.url, path.join(modsDir, info.fileName))
                await writeModState(statePath, { slug, name: mod.name, version: info.version, fileName: info.fileName, size: info.size })
                item.status = 'installed'
                item.version = info.version
                item.fileName = info.fileName
                items.push(item)
                continue
            }

            if(inDisabled && !inMods){
                await moveFileIfExists(path.join(disabledDir, fileName), path.join(modsDir, fileName))
                item.status = 'installed'
                items.push(item)
                continue
            }

            // 필수 모드는 자동으로 최신 버전에 맞춥니다.
            // 선택 모드는 그대로 두고, 사용자가 직접 업데이트 버튼을 누릅니다.
            if(mod.required && item.version != null && info.version != null && item.version !== info.version){
                const target = path.join(modsDir, info.fileName)
                if(fileName !== info.fileName){
                    await fs.promises.rm(path.join(modsDir, fileName), { force: true })
                }
                await fs.promises.rm(target, { force: true })
                await downloadToFile(info.url, target)
                await writeModState(statePath, {
                    slug,
                    name: mod.name,
                    version: info.version,
                    fileName: info.fileName,
                    size: info.size
                })
                console.log(`[Mods] 필수 모드를 자동 업데이트했습니다: ${mod.name} (${item.version} -> ${info.version})`)
                item.status = 'installed'
                item.version = info.version
                item.fileName = info.fileName
                item.autoUpdated = true
                items.push(item)
                continue
            }

            item.status = item.version != null && item.version !== info.version ? 'outdated' : 'installed'
            items.push(item)
        } catch (err) {
            item.reason = err.message
            failures.push(`${mod.name}: ${err.message}`)
            items.push(item)
        }
    }

    try {
        await ensureServerEntry(directory, serverAddress, quickPlayAddress)
    } catch (err) {
        console.warn('[Mods] servers.dat 을 쓰지 못했습니다.', err.message)
    }

    return {
        ok: failures.length === 0,
        items,
        reason: failures.length > 0 ? failures.join('\n') : null
    }
})

ipcMain.handle('getModStatus', async (event, options) => {
    const { directory, disabledUrls } = options || {}
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.', items: [] }
    }

    const disabled = new Set(Array.isArray(disabledUrls) ? disabledUrls : [])
    const modsDir = path.join(directory, 'mods')
    const disabledDir = path.join(directory, MOD_DISABLED_DIR)
    await fs.promises.mkdir(modsDir, { recursive: true })

    let list
    try {
        list = await fetchModList()
    } catch (err) {
        return { ok: false, items: [], reason: `모드 목록을 받아오지 못했습니다. (${err.message})` }
    }

    const wanted = [
        ...list.required.map(m => ({ ...m, required: true })),
        ...list.optional.map(m => ({ ...m, required: false }))
    ]

    const items = []
    for(const mod of wanted){
        const item = {
            name: mod.name,
            url: mod.url,
            slug: modStateKey(mod.url),
            required: mod.required,
            enabled: !disabled.has(mod.url),
            status: 'failed'
        }

        try {
            if(item.slug == null){
                throw new Error('지원하지 않는 주소입니다. (모드린스 주소 또는 jar 주소)')
            }
            const info = await resolveModTarget(mod.url)
            if(info == null){
                throw new Error(`${MOD_GAME_VERSION} + ${MOD_LOADER} 버전을 찾지 못했습니다.`)
            }
            item.latestVersion = info.version

            const state = await readJsonIfExists(path.join(modsDir, `${MOD_STATE_FILE_PREFIX}${item.slug}.json`))
            const fileName = state != null && typeof state.fileName === 'string'
                ? path.basename(state.fileName)
                : info.fileName
            item.fileName = fileName
            item.version = state != null ? (state.version || null) : null

            const inMods = (await fileSizeIfExists(path.join(modsDir, fileName))) != null
            const inDisabled = (await fileSizeIfExists(path.join(disabledDir, fileName))) != null

            if(!inMods && !inDisabled){
                item.status = 'missing'
            } else if(!item.enabled){
                item.status = 'disabled'
            } else if(inDisabled && !inMods){
                item.status = 'toEnable'
            } else if(item.version != null && item.version !== info.version){
                item.status = 'outdated'
                item.updateAvailable = true
            } else {
                item.status = 'installed'
            }
        } catch (err) {
            item.reason = err.message
        }
        items.push(item)
    }

    return { ok: true, items }
})

ipcMain.handle('updateMod', async (event, options) => {
    const { directory, url } = options || {}
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.' }
    }

    const slug = modStateKey(url)
    if(slug == null){
        return { ok: false, reason: '지원하지 않는 주소입니다. (모드린스 주소 또는 jar 주소)' }
    }

    try {
        const info = await resolveModTarget(url)
        if(info == null){
            return { ok: false, reason: `${MOD_GAME_VERSION} + ${MOD_LOADER} 버전을 찾지 못했습니다.` }
        }

        const modsDir = path.join(directory, 'mods')
        const disabledDir = path.join(directory, MOD_DISABLED_DIR)
        await fs.promises.mkdir(modsDir, { recursive: true })

        const statePath = path.join(modsDir, `${MOD_STATE_FILE_PREFIX}${slug}.json`)
        const old = await readJsonIfExists(statePath)

        if(old != null && typeof old.fileName === 'string' && old.fileName !== info.fileName){
            await fs.promises.rm(path.join(modsDir, path.basename(old.fileName)), { force: true })
            await fs.promises.rm(path.join(disabledDir, path.basename(old.fileName)), { force: true })
        }

        await fs.promises.rm(path.join(modsDir, info.fileName), { force: true })
        await downloadToFile(info.url, path.join(modsDir, info.fileName))
        await writeModState(statePath, {
            slug,
            name: old != null ? old.name : slug,
            version: info.version,
            fileName: info.fileName,
            size: info.size
        })

        return { ok: true, version: info.version, fileName: info.fileName }
    } catch (err) {
        return { ok: false, reason: err.message }
    }
})

const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}
            
            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v;
            });

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

let win

function createWindow() {

    win = new BrowserWindow({
        width: 980,
        height: 552,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#171614'
    })
    remoteMain.enable(win.webContents)

    // 'once' 로 두면 새로 고침 뒤에도 준비됨으로 남아 메시지가 사라지므로(무한 로딩) 매번 초기화합니다.
    win.webContents.on('did-start-loading', () => {
        rendererDomReady.delete(win.webContents)
    })
    win.webContents.on('dom-ready', () => {
        rendererDomReady.add(win.webContents)
        flushDistributionIndexDone(win.webContents)
    })

    const data = {
        bkid: Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)),
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())


    win.removeMenu()

    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return
        }
        const isF12 = input.key === 'F12'
        const isDevToolsCombo = input.control && input.shift && input.key.toLowerCase() === 'i'
        if (isF12 || isDevToolsCombo) {
            win.webContents.toggleDevTools()
            event.preventDefault()
        }
    })

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    
    if(process.platform === 'darwin') {

        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

app.on('ready', () => {
    // 어떤 이유로든 이 호출이 실패해도 창은 반드시 떠야 합니다.
    try { launchLogSystemInfo() } catch (err) { console.error('[launchLog]', err) }
    // 창을 띄우는 것과 동시에 오너 목록을 받아 둡니다. (트리거 판정용)
    loadPrivateOwners().catch(err => launchLog('PRIVATE', 'owners 로드 실패: ' + (err.message || err)))
})
app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    launchLog('SYS', '모든 창이 닫혀 런처를 종료합니다.')
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    if (win === null) {
        createWindow()
    }
})

// ===== 런처 진단 로그 =====
// 플레이 버튼을 누른 시점부터의 모든 과정을 파일로 남깁니다.
//   위치: <userData>/logs/launcher.log     (예: %APPDATA%\Barkan Launcher\logs\launcher.log)
//
// 목적: 게임이 logs/latest.log 를 만들기 전에 실패하면 아무 흔적도 남지 않습니다.
//       ("왜 게임이 안 켜지나" 를 알 수 없게 되는 문제) 그 구간을 기록합니다.

const LAUNCH_LOG_MAX_BYTES = 8 * 1024 * 1024
let launchLogFile = null
let launchLogReady = false

function launchLogPath() {
    if (launchLogFile == null) {
        launchLogFile = path.join(app.getPath('userData'), 'logs', 'launcher.log')
    }
    return launchLogFile
}

function launchLogTimestamp() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
        + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.'
        + String(d.getMilliseconds()).padStart(3, '0')
}

function launchLogEnsure() {
    if (launchLogReady) {
        return
    }
    const file = launchLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
        // 무한히 커지지 않게, 일정 크기를 넘으면 한 번만 옮겨 둡니다.
        if (fs.existsSync(file) && fs.statSync(file).size > LAUNCH_LOG_MAX_BYTES) {
            fs.renameSync(file, file + '.old')
        }
    } catch (err) { /* 무시 */ }
    launchLogReady = true
}

function launchLog(scope, message) {
    try {
        launchLogEnsure()
        let text
        if (message == null) {
            text = ''
        } else if (typeof message === 'string') {
            text = message
        } else if (message instanceof Error) {
            text = message.stack || message.message
        } else {
            try { text = JSON.stringify(message) } catch (err) { text = String(message) }
        }
        fs.appendFileSync(launchLogPath(), '[' + launchLogTimestamp() + '] [' + scope + '] ' + text + '\n', 'utf8')
    } catch (err) {
        // 로그를 못 써도 앱 동작에는 영향이 없게 합니다.
    }
}

function launchLogSection(title) {
    launchLog('----', '')
    launchLog('----', '==================== ' + title + ' ====================')
}

function launchLogSystemInfo() {
    // 로깅이 앱 시작을 막으면 안 됩니다.
    try {
    const cpus = os.cpus() || []
    launchLogSection('런처 시작')
    launchLog('SYS', '런처 버전   : ' + app.getVersion())
    launchLog('SYS', '플랫폼      : ' + process.platform + ' / ' + process.arch)
    launchLog('SYS', 'OS          : ' + os.type() + ' ' + os.release() + ' (빌드 ' + os.version() + ')')
    launchLog('SYS', 'CPU         : ' + ((cpus[0] || {}).model || '?') + '  (' + cpus.length + ' 코어)')
    launchLog('SYS', '메모리      : 전체 ' + (os.totalmem() / 1073741824).toFixed(1) + 'GB / 여유 ' + (os.freemem() / 1073741824).toFixed(1) + 'GB')
    launchLog('SYS', 'Electron    : ' + process.versions.electron + '   Chrome ' + process.versions.chrome + '   Node ' + process.versions.node)
    launchLog('SYS', 'userData    : ' + app.getPath('userData'))
    launchLog('SYS', 'appData     : ' + app.getPath('appData'))
    launchLog('SYS', '실행 파일   : ' + app.getPath('exe'))
    launchLog('SYS', '개발 모드   : ' + isDev)
    } catch (err) {
        console.error('[launchLog] 시스템 정보 기록 실패:', err)
    }
}

// ===== 개인 프로필 트리거 =====
// 계정 UUID 의 SHA-256 이 이 목록에 있으면 "오너" 로 판정합니다.
// 판정 결과는 화면 표시용이며, 개인 모드 동기화는 이후 단계에서 연결합니다.
const PRIVATE_OWNERS_URL = 'https://raw.githubusercontent.com/teddy-wooma/FISH_MOD_LIST/main/owners.json'

let privateOwners = null
let privateOwnersSource = null

function privateOwnersCachePath() {
    return path.join(app.getPath('userData'), 'private-owners.json')
}

async function loadPrivateOwners() {
    // 1) 네트워크에서 먼저 시도합니다.
    try {
        const response = await fetch(PRIVATE_OWNERS_URL, {
            headers: { 'user-agent': 'BarkanLauncher/' + app.getVersion() },
            signal: AbortSignal.timeout(10000)
        })
        if (response.ok) {
            const data = await response.json()
            if (data != null && Array.isArray(data.owners)) {
                privateOwners = new Set(data.owners.map(h => String(h).toLowerCase()))
                privateOwnersSource = 'network'
                // 오프라인일 때를 대비해 캐시해 둡니다.
                try {
                    fs.writeFileSync(privateOwnersCachePath(),
                        JSON.stringify({ owners: Array.from(privateOwners) }), 'utf8')
                } catch (err) { /* 캐시 실패는 무시 */ }
                launchLog('PRIVATE', 'owners.json 갱신 (' + privateOwners.size + '개)')
                return
            }
        }
    } catch (err) {
        // 네트워크 실패 → 캐시로 넘어갑니다.
    }

    // 2) 캐시 사용 (PC방처럼 네트워크가 불안할 때)
    try {
        const cachePath = privateOwnersCachePath()
        if (fs.existsSync(cachePath)) {
            const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
            if (data != null && Array.isArray(data.owners)) {
                privateOwners = new Set(data.owners.map(h => String(h).toLowerCase()))
                privateOwnersSource = 'cache'
                launchLog('PRIVATE', 'owners.json 캐시 사용 (' + privateOwners.size + '개)')
                return
            }
        }
    } catch (err) { /* 무시 */ }

    privateOwnersSource = null
    launchLog('PRIVATE', 'owners.json 을 읽지 못했습니다 (오프라인일 수 있습니다)')
}

// 렌더러는 UUID 가 아니라 해시만 보냅니다. (UUID 원본은 IPC 로 오가지 않습니다)
ipcMain.handle('privateOwnerCheck', async (event, uuidHash) => {
    if (privateOwners == null) {
        await loadPrivateOwners()
    }
    const isOwner = privateOwners != null
        && typeof uuidHash === 'string'
        && privateOwners.has(uuidHash.toLowerCase())
    // 해시 자체는 로그에 남기지 않습니다.
    launchLog('PRIVATE', '트리거 판정: ' + (isOwner ? '오너' : '일반') + '  (출처 ' + privateOwnersSource + ')')
    return { isOwner: isOwner, source: privateOwnersSource }
})

// ===== 개인 프로필 동기화 (오너 전용) =====
// 오너로 판정된 계정에서만 호출됩니다. (판정은 renderer 가 하고, 여기서는 실행만)
//
//   mods-private\  에 개인 모드 jar 를 받아 둡니다.
//   files.zip      을 풀어 게임 폴더에 "없는 파일만" 복사합니다.
//                  (이미 있는 파일은 사용자가 만든 데이터이므로 건드리지 않습니다)

const PRIVATE_REPO_BASE = 'https://raw.githubusercontent.com/teddy-wooma/Luna_MOD_LIST/main/'
const PRIVATE_MODS_DIR = 'mods-private'

function privateSha1File(filePath) {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex')
}

async function fetchPrivateJson(url) {
    const response = await fetch(url, {
        headers: { 'user-agent': 'BarkanLauncher/' + app.getVersion() },
        signal: AbortSignal.timeout(20000)
    })
    if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' — ' + url)
    }
    return response.json()
}

// 웨이포인트 파일 병합
//
// Xaero 의 웨이포인트 파일은 줄 단위 텍스트입니다.
//   sets:<세트1>:<세트2>...                     ← 세트 목록 (한 줄)
//   #                                            ← 주석/헤더
//   waypoint:<이름>:<이니셜>:<x>:<y>:<z>:...     ← 웨이포인트 (한 줄에 하나)
//
// 그래서 이미 웨이포인트가 있는 사용자도 "추가"가 되도록 줄 단위로 합칩니다.
// (기존 줄은 순서 그대로 보존하고, 없는 웨이포인트만 뒤에 붙입니다)
// 웨이포인트 파일 병합
//
// Xaero 의 웨이포인트 파일은 줄 단위 텍스트입니다.
//   sets:<세트1>:<세트2>...                     <- 세트 목록 (한 줄)
//   #                                            <- 주석/헤더
//   waypoint:<이름>:<이니셜>:<x>:<y>:<z>:...     <- 웨이포인트 (한 줄에 하나)
//
// 그래서 이미 웨이포인트가 있는 사용자도 "추가"가 되도록 줄 단위로 합칩니다.
// (기존 줄은 순서 그대로 보존하고, 없는 웨이포인트만 뒤에 붙입니다)
function mergeWaypointText(existingText, incomingText) {
    const CR = String.fromCharCode(13)
    const LF = String.fromCharCode(10)
    const splitLines = t => String(t).split(CR + LF).join(LF).split(LF)

    const exLines = splitLines(existingText)
    const inLines = splitLines(incomingText)

    // 세트 이름 합집합
    const sets = []
    for (const line of exLines.concat(inLines)) {
        if (line.startsWith('sets:')) {
            for (const name of line.split(':').slice(1)) {
                if (name.length > 0 && sets.indexOf(name) < 0) {
                    sets.push(name)
                }
            }
        }
    }

    // 기존 줄에서 sets:/빈 줄 제외
    const kept = []
    const existingKeys = new Set()
    for (const line of exLines) {
        if (line.startsWith('sets:')) {
            continue
        }
        if (line.trim().length === 0) {
            continue
        }
        kept.push(line)
        existingKeys.add(line.trim())
    }

    // 저장소에는 있는데 사용자에게 없는 웨이포인트만 추가
    let added = 0
    for (const line of inLines) {
        if (!line.startsWith('waypoint:')) {
            continue
        }
        const key = line.trim()
        if (existingKeys.has(key)) {
            continue
        }
        existingKeys.add(key)
        kept.push(line)
        added++
    }

    const out = []
    if (sets.length > 0) {
        out.push('sets:' + sets.join(':'))
    }
    for (const line of kept) {
        out.push(line)
    }
    return { text: out.join(LF) + LF, added: added }
}


async function syncPrivateProfile(gameDir) {
    const result = { ok: false, modsDir: path.join(gameDir, PRIVATE_MODS_DIR), added: 0, skipped: 0, written: 0, kept: 0, errors: [] }

    if (typeof gameDir !== 'string' || gameDir.length === 0) {
        result.errors.push('게임 폴더를 알 수 없습니다.')
        return result
    }

    launchLogSection('개인 프로필 동기화')

    // 1) 매니페스트
    const manifest = await fetchPrivateJson(PRIVATE_REPO_BASE + 'private.json')
    if (manifest == null || !Array.isArray(manifest.mods)) {
        throw new Error('private.json 형식이 올바르지 않습니다.')
    }
    launchLog('PRIVATE', '매니페스트: 모드 ' + manifest.mods.length + '개')

    // 2) 개인 모드 → mods-private\
    const modsDir = path.join(gameDir, PRIVATE_MODS_DIR)
    await fs.promises.mkdir(modsDir, { recursive: true })

    for (const mod of manifest.mods) {
        const target = path.join(modsDir, mod.name)
        try {
            if (fs.existsSync(target) && mod.sha1 && privateSha1File(target) === mod.sha1) {
                result.skipped++
                continue
            }
            await downloadToFile(PRIVATE_REPO_BASE + 'mods/' + encodeURIComponent(mod.name), target, null, mod.sha1)
            result.added++
            launchLog('PRIVATE', '  모드 받음: ' + mod.name)
        } catch (err) {
            result.errors.push(mod.name + ': ' + (err.message || err))
            launchLog('PRIVATE', '  모드 실패: ' + mod.name + ' — ' + (err.message || err))
        }
    }

    // 3) 설정 zip → 게임 폴더 (없는 파일만)
    if (manifest.files != null && manifest.files.url != null) {
        const zipPath = path.join(os.tmpdir(), 'barkan-private-files.zip')
        try {
            await downloadToFile(PRIVATE_REPO_BASE + manifest.files.url, zipPath, null, manifest.files.sha1)

            const AdmZip = require('adm-zip')
            const zip = new AdmZip(zipPath)
            const gameDirResolved = path.resolve(gameDir)

            for (const entry of zip.getEntries()) {
                if (entry.isDirectory) {
                    continue
                }
                const rel = entry.entryName.split('/').join(path.sep)
                const target = path.join(gameDir, rel)

                // zip 안의 경로가 게임 폴더 밖으로 나가면 건너뜁니다.
                if (!path.resolve(target).startsWith(gameDirResolved + path.sep)) {
                    launchLog('PRIVATE', '  경로 차단: ' + entry.entryName)
                    continue
                }
                // 이미 있으면 보존합니다. 단, 웨이포인트는 "추가"가 되도록 병합합니다.
                if (fs.existsSync(target)) {
                    const mergePatterns = Array.isArray(manifest.files.merge) ? manifest.files.merge : []
                    const isMergeTarget = mergePatterns.some(p => {
                        try { return new RegExp(p).test(rel.split(path.sep).join('/')) } catch (e) { return false }
                    })

                    if (isMergeTarget && /\.txt$/i.test(rel)) {
                        try {
                            const before = await fs.promises.readFile(target, 'utf8')
                            const merged = mergeWaypointText(before, entry.getData().toString('utf8'))
                            if (merged.added > 0) {
                                // 되돌릴 수 있게 백업을 남깁니다.
                                const backup = target + '.before-private.bak'
                                if (!fs.existsSync(backup)) { await fs.promises.copyFile(target, backup) }
                                await fs.promises.writeFile(target, merged.text, 'utf8')
                                result.merged = (result.merged || 0) + 1
                                launchLog('PRIVATE', '  웨이포인트 병합: ' + rel + ' (+' + merged.added + '개)')
                            } else {
                                result.kept++
                            }
                        } catch (mergeErr) {
                            result.errors.push(rel + ': 병합 실패 — ' + (mergeErr.message || mergeErr))
                            launchLog('PRIVATE', '  병합 실패: ' + rel + ' — ' + (mergeErr.message || mergeErr))
                        }
                        continue
                    }

                    result.kept++
                    continue
                }
                await fs.promises.mkdir(path.dirname(target), { recursive: true })
                await fs.promises.writeFile(target, entry.getData())
                result.written++
            }
            await fs.promises.rm(zipPath, { force: true }).catch(() => {})
            launchLog('PRIVATE', '설정: 새로 ' + result.written + '개 / 기존 보존 ' + result.kept + '개')
        } catch (err) {
            result.errors.push('files: ' + (err.message || err))
            launchLog('PRIVATE', '설정 동기화 실패: ' + (err.message || err))
        }
    }

    // 매니페스트에 없는 파일은 제거합니다.
    // 모드 이름이나 버전이 바뀌면 옛 파일이 남아 두 개가 동시에 로드되므로 정리합니다.
    try {
        const expectedNames = new Set(manifest.mods.map(m => m.name))
        if (expectedNames.size > 0) {
            for (const fileName of await fs.promises.readdir(modsDir)) {
                if (!/\.jar$/i.test(fileName)) {
                    continue
                }
                if (expectedNames.has(fileName)) {
                    continue
                }
                await fs.promises.rm(path.join(modsDir, fileName), { force: true })
                result.removed = (result.removed || 0) + 1
                launchLog('PRIVATE', '  옛 모드 제거: ' + fileName)
            }
        }
    } catch (cleanErr) {
        launchLog('PRIVATE', '옛 모드 정리 실패: ' + (cleanErr.message || cleanErr))
    }

    result.ok = result.errors.length === 0
    launchLog('PRIVATE', '결과: 모드 신규 ' + result.added + ' / 유지 ' + result.skipped +
        ' , 설정 신규 ' + result.written + ' / 보존 ' + result.kept +
        ' , 옛 모드 제거 ' + (result.removed || 0) + ' , 오류 ' + result.errors.length)
    return result
}

ipcMain.handle('privateSyncProfile', async (event, gameDir) => {
    try {
        return await syncPrivateProfile(gameDir)
    } catch (err) {
        launchLog('PRIVATE', '동기화 예외: ' + (err && err.message ? err.message : err))
        return { ok: false, modsDir: null, added: 0, skipped: 0, written: 0, kept: 0, errors: [String(err && err.message ? err.message : err)] }
    }
})

// 렌더러(화면 쪽)에서 보내는 로그를 받아 같은 파일에 씁니다.
ipcMain.on('launcherLog', (event, scope, message) => {
    launchLog(scope || 'UI', message)
})

// 로그 파일이 있는 폴더를 열어 줍니다. (사용자가 파일을 찾기 쉽게)
ipcMain.on('launcherLogOpenFolder', () => {
    try {
        launchLogEnsure()
        shell.showItemInFolder(launchLogPath())
    } catch (err) {
        launchLog('WARN', '로그 폴더 열기 실패: ' + (err.message || err))
    }
})

ipcMain.handle('launcherLogPathGet', () => launchLogPath())

// 예기치 못한 오류도 남깁니다. (이게 없으면 조용히 죽습니다)
process.on('uncaughtException', (err) => {
    launchLog('FATAL', 'uncaughtException: ' + (err && err.stack ? err.stack : String(err)))
})
process.on('unhandledRejection', (reason) => {
    launchLog('FATAL', 'unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason)))
})
