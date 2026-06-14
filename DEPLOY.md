# 인터넷에 공개해서 다른 사람과 함께 쓰기 (비개발자용 가이드)

이 보드를 "링크만 주면 누구나 접속해 같이 보는" 상태로 만들려면, `server.js`(Node 서버)를
인터넷에서 실행해 줄 호스트가 필요합니다. 아래는 **무료**로 가장 쉽게 하는 방법입니다.

> ❗ **GitHub Pages는 안 됩니다.** Pages는 정적 파일만 올라가고 서버를 못 돌려서,
> 거기서는 같은 브라우저 탭끼리만 동기화됩니다. 아래 Render 방법을 쓰세요.

---

## 준비물

1. GitHub 계정 (이미 `jh-dex/test-app` 저장소가 있으니 OK)
2. 이번에 수정한 파일들이 GitHub 저장소에 올라가 있어야 합니다.
   - 아직 안 올렸다면: GitHub 저장소 페이지에서 `Add file → Upload files`로
     `server.js`, `app.js`, `index.html`, `README.md`, `package.json`, `render.yaml`을 끌어다 올리고
     `Commit changes`를 누르면 됩니다. (Claude에게 "GitHub에 올리는 것까지 도와줘"라고 하면 같이 진행 가능)

---

## 방법 A — Render (추천, 무료)

1. https://render.com 접속 → `Get Started` → **GitHub 계정으로 로그인**.
2. 로그인 후 `New +` → **`Web Service`** 선택.
3. 목록에서 **`jh-dex/test-app`** 저장소를 고릅니다. (안 보이면 `Configure account`로 저장소 접근 권한 허용)
4. 설정 화면이 뜨면 대부분 자동으로 채워집니다. 다음만 확인:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. `Create Web Service` 클릭 → 1~2분 기다리면 배포 완료.
6. 화면 상단에 `https://live-board-mvp-xxxx.onrender.com` 같은 **공개 주소**가 생깁니다.
   이 주소를 다른 사람에게 보내면, 접속한 모두가 같은 보드를 실시간으로 함께 봅니다. 🎉

### 알아둘 점 (무료 플랜)
- 한동안 아무도 안 들어오면 서버가 잠들고, 다음 접속 때 깨어나는 데 **30~50초** 걸릴 수 있습니다.
  (첫 접속이 느린 건 정상)
- 보드 내용은 서버 메모리에만 있어서 **서버가 재시작되면 초기화**됩니다.
  영구 저장이 필요하면 Claude에게 "DB 저장 붙여줘"라고 요청하세요.

---

## 방법 B — Railway (대안)

1. https://railway.app → GitHub로 로그인.
2. `New Project` → `Deploy from GitHub repo` → `jh-dex/test-app` 선택.
3. 자동으로 `npm install` → `npm start` 실행. 배포되면 `Settings → Networking`에서
   `Generate Domain`을 눌러 공개 주소를 만듭니다.

---

## 잘 됐는지 확인하는 법

1. 받은 공개 주소를 내 브라우저에서 엽니다.
2. 펜으로 아무거나 그립니다.
3. **다른 기기(또는 휴대폰, 또는 시크릿창)** 에서 같은 주소를 엽니다.
4. 방금 그린 그림이 그대로 보이고, 한쪽에서 그리면 다른 쪽에 실시간으로 나타나면 성공입니다.
