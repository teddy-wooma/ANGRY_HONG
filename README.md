# 바르칸 열도 접속기 (Barkan Launcher)

바르칸 열도 서버(`barkan.kr`) 전용 마인크래프트 런처입니다.
모드·설정·업데이트가 자동으로 관리되며, 설치 후 로그인만 하면 바로 접속할 수 있습니다.

- 마인크래프트 **1.21.11 / Fabric**
- Microsoft 계정 로그인
- 모드 자동 설치 및 업데이트
- 서버 전용 설정(웨이포인트 등) 자동 배포

---

## 다운로드

**[최신 버전 내려받기](https://github.com/teddy-wooma/ANGRY_HONG/releases/latest)**

| 플랫폼 | 파일 |
| --- | --- |
| Windows (x64) | `Barkan-Launcher-setup-<버전>.exe` |
| macOS (Apple Silicon) | `Barkan-Launcher-setup-<버전>-arm64.dmg` |
| macOS (Intel) | `Barkan-Launcher-setup-<버전>-x64.dmg` |

설치 후 바탕화면의 **바르칸 열도 접속기** 아이콘을 실행하세요.
이후에는 런처가 자동으로 새 버전을 확인합니다.

---

## 사용 방법

1. 런처를 실행합니다.
2. **Microsoft 계정으로 로그인**합니다.
3. **플레이** 버튼을 누릅니다.

첫 실행 시 게임 파일과 모드를 내려받기 때문에 시간이 걸립니다.
두 번째 실행부터는 변경된 모드만 갱신합니다.

---

## 문제 해결

로그 파일 위치:

```
%APPDATA%\.barkanlauncher\launcher.log
%APPDATA%\.barkanlauncher\instances\barkan\logs\latest.log
```

- 창이 뜨지 않으면 `--no-sandbox` 옵션을 붙여 실행해 보세요.
- 모드 충돌이 의심되면 `instances\barkan\mods` 폴더를 확인하세요.

---

## 개발

### 요구 사항

- Node.js 22 이상
- JDK 21 (모드 빌드용)

### 실행

```bash
npm install
npm start
```

### 빌드

```bash
# 전체 빌드 (Windows 설치 파일)
npm run dist

# 패키징만 (설치 파일 없이 실행 폴더)
npm run pack
```

빌드 결과물은 `dist/` 에 생성됩니다.

### 구조

```
index.js                 메인 프로세스 (게임 실행, 모드 동기화, 업데이트)
app/
  assets/js/             렌더러 스크립트
  assets/css/            스타일
  settings.ejs           설정 화면
electron-builder.yml     패키징 설정
mods.json                배포 모드 목록
release-notes.md         릴리즈 노트
```

---

## 라이선스

이 프로젝트는 Helios Launcher 를 기반으로 합니다.
자세한 내용은 [LICENSE.txt](LICENSE.txt) 를 참고하세요.
