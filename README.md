# Focus Sprint MVP

아주 가볍게 만든 웹 기반 MVP입니다. 하루 목표를 기록하고 완료 체크할 수 있습니다.

## 기능

- 목표 추가
- 완료/미완료 토글
- 필터(전체/진행중/완료)
- 완료 항목 일괄 삭제
- LocalStorage 저장 (새로고침 후 유지)

## 실행 방법

별도 의존성 없이 정적 파일로 동작합니다.

```bash
python3 -m http.server 8080
```

브라우저에서 `http://localhost:8080` 접속.
