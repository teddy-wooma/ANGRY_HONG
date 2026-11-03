// 커스텀 번들 생성 스크립트
//
//   실행: node tools/build-custom-bundle.cjs [원본 인스턴스 경로]
//
// 게임 인스턴스에서 "모드 · 세부 설정 · 맵 캐시"만 골라
// dist/custom-bundle.zip 으로 묶습니다.
// 이 zip 은 배포 저장소 릴리즈에 올리고, 런처가 PLAY 시 내려받아
// "없는 파일만" 게임 폴더에 풀어 넣습니다.

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')

const DEFAULT_INSTANCE = path.join(
    process.env.APPDATA || '', '.barkanlauncher', 'instances', 'barkan'
)
const instance = process.argv[2] || DEFAULT_INSTANCE
const outFile = path.join(__dirname, '..', 'dist', 'custom-bundle.zip')

// 서버 이름이 들어간 폴더만 가져옵니다. (다른 서버 캐시 제외)
const SERVER_FOLDER = 'Multiplayer_barkan.kr'

function human(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB'
}

function walk(dir, base, list) {
    if (!fs.existsSync(dir)) {
        return
    }
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
            walk(full, path.join(base, name), list)
        } else {
            list.push({ full, rel: path.join(base, name), size: stat.size })
        }
    }
}

function collect() {
    const files = []

    // 1) 모드 (jar 만. .barkan-*.json 상태 파일은 제외)
    const modsDir = path.join(instance, 'mods')
    if (fs.existsSync(modsDir)) {
        for (const name of fs.readdirSync(modsDir)) {
            if (!/\.jar$/i.test(name)) {
                continue
            }
            const full = path.join(modsDir, name)
            const stat = fs.statSync(full)
            if (!stat.isFile()) {
                continue
            }
            files.push({ full, rel: path.join('mods', name), size: stat.size })
        }
    }

    // 2) 세부 설정 (config 폴더 전체)
    walk(path.join(instance, 'config'), 'config', files)

    // 3) 게임 옵션 (신규 설치에만 적용되도록 "없는 파일만" 복사됩니다)
    const options = path.join(instance, 'options.txt')
    if (fs.existsSync(options)) {
        files.push({ full: options, rel: 'options.txt', size: fs.statSync(options).size })
    }

    // 4) 미니맵 웨이포인트 (해당 서버만)
    walk(
        path.join(instance, 'xaero', 'minimap', SERVER_FOLDER),
        path.join('xaero', 'minimap', SERVER_FOLDER),
        files
    )

    // 5) 맵 캐시 (해당 서버만)
    walk(
        path.join(instance, 'xaero', 'world-map', SERVER_FOLDER),
        path.join('xaero', 'world-map', SERVER_FOLDER),
        files
    )

    return files
}

function main() {
    if (!fs.existsSync(instance)) {
        console.error('인스턴스 폴더를 찾을 수 없습니다:', instance)
        process.exit(1)
    }

    console.log('원본 인스턴스 :', instance)

    const files = collect()
    if (files.length === 0) {
        console.error('담을 파일이 없습니다.')
        process.exit(1)
    }

    const total = files.reduce((sum, f) => sum + f.size, 0)
    console.log('파일 수        :', files.length)
    console.log('압축 전 크기   :', human(total))

    // 분류별 통계
    const groups = {}
    for (const f of files) {
        const top = f.rel.split(path.sep)[0]
        groups[top] = groups[top] || { count: 0, size: 0 }
        groups[top].count += 1
        groups[top].size += f.size
    }
    for (const key of Object.keys(groups).sort()) {
        console.log(
            '  - ' + key.padEnd(16),
            String(groups[key].count).padStart(5) + '개',
            human(groups[key].size).padStart(10)
        )
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    if (fs.existsSync(outFile)) {
        fs.rmSync(outFile, { force: true })
    }

    const zip = new AdmZip()
    let done = 0
    for (const f of files) {
        // zip 안에서는 항상 '/' 구분자를 씁니다.
        zip.addFile(f.rel.split(path.sep).join('/'), fs.readFileSync(f.full))
        done += 1
        if (done % 200 === 0) {
            console.log('  ... ' + done + '/' + files.length)
        }
    }

    zip.writeZip(outFile)

    const outSize = fs.statSync(outFile).size
    console.log('')
    console.log('생성 완료 :', outFile)
    console.log('압축 후   :', human(outSize))
    console.log('압축률    :', ((outSize / total) * 100).toFixed(1) + '%')
}

main()
