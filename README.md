# Live Board MVP Draft

피그마 느낌의 **웹 기반 실시간 작업 보드 MVP 초안**입니다.

## 포함 기능 (MVP)

- 실시간 스케치(펜/지우개)
- 보드 드래그앤드롭 이미지 추가
- 이미지 자유 이동(마우스 드래그)
- 확대/축소 퍼센트 HUD(+) (-) 및 Ctrl+휠 줌
- 같은 브라우저 여러 탭 간 실시간 동기화(BroadcastChannel)
- 간단한 참여자(presence) 표시

> 참고: 현재는 브라우저 탭 간 동기화 기준입니다. 즉, **같은 브라우저/같은 기기**에서 탭 여러 개를 열었을 때 실시간 동기화가 됩니다.

## 로컬 실행

```bash
python3 -m http.server 4173
```

브라우저에서 `http://localhost:4173` 접속 후,
같은 주소를 탭 여러 개로 열어 실시간 동기화를 확인하세요.

## GitHub Pages 배포 (웹에 바로 띄우기)

이 리포에는 `main` 브랜치 push 시 자동 배포되는 워크플로우가 포함되어 있습니다.

1. GitHub 저장소에서 **Settings → Pages** 이동
2. **Build and deployment** 를 **GitHub Actions** 로 설정
3. `main` 브랜치에 push
4. Actions의 `Deploy to GitHub Pages` 완료 후 아래 주소로 접속

```text
https://<github-username>.github.io/<repo-name>/
```

## 한계 / 다음 단계

1. 다른 기기/다른 사용자 간 실시간 협업(WebSocket/SSE 백엔드 필요)
2. 오브젝트 선택/리사이즈/회전
3. 보드 저장/불러오기
4. 권한(읽기/쓰기), 링크 초대
