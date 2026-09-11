# Test — 금리·환율·크레딧 대시보드

[liskay93/Data](https://github.com/liskay93/Data) 저장소가 만들어 내는 **산출물(`output/`)만 받아와** 보여주는 정적 대시보드입니다.
원본 엑셀(`data_info.xlsx`)과 변환 로직은 Data 저장소에만 있고, 이 저장소에는 화면(HTML/CSS/JS)과 배포 워크플로만 있습니다.

```
Data 저장소                                   Test 저장소 (이 저장소)
data_info.xlsx ──build_output.py──▶ output/ ──▶ data/ (배포 시 복사) ──▶ index.html + assets/
```

## 화면 구성

| 섹션 | 내용 |
|---|---|
| 주요 지표 | 국고채 3년/10년, 기준금리, 미국 국채 2년/10년, FFR, 달러/원, 회사채 AA- 3년, 미국 HY OAS, VKOSPI — 최신값·전일 대비(bp)·1M/YTD/1Y 변화·스파크라인 |
| 국채 수익률 곡선 | 한국·미국·일본·호주·독일, 기준일 vs 1주/1개월/3개월/1년 전 비교 |
| 금리 추이 | 국고채 3·10년+기준금리, 미국 2·10년+FFR, 기간 스프레드·한미 금리차(bp), 주요국 10년 |
| 정책금리 | 한국·미국·유로·일본·호주 (계단형) |
| 크레딧 | 신용 스프레드(3년물−국고 3년), 단기금리(CD·CP), 미국 IG/HY OAS, 섹터·등급별 크레딧 커브 |
| 환율·스왑·헤지 | 주요 환율 타일, 달러/원, 환율 지수화 비교, SMB 스왑레이트, 통화별 환헤지 프리미엄 |
| BEI | 주요국 BEI 10년, 한국·미국 실질금리(국채 10년 − BEI 10년) |
| 데이터 정보 | 원본 파일·생성 시각·SHA-256, 원본 데이터 주의사항, 정제 내역(quality_report) |
| 변동성 | VKOSPI, VIX |
| 국고채 수급 | 기간 내 투자자별 순매수 합계(막대), 누적 순매수 추이 |
| 시리즈 탐색기 | 전체 시리즈 중 최대 4개 자유 비교 (단위가 다르면 자동 지수화, 기준값이 0 이하인 시리즈는 지수화 제외) |

- 상단 **기간 필터**(1M ~ 전체, 사용자 지정)는 시계열 차트와 수급 합계에 공통 적용됩니다. 주요 지표·주요 환율 타일은 항상 최신 거래일 값이고,
  국채 수익률 곡선·크레딧 커브는 필터의 **종료일**만 사용합니다.
- 시계열·수익률 곡선 차트는 범례 클릭으로 시리즈 숨기기, 크로스헤어 툴팁(마우스·터치, 키보드 ←/→), **표 보기**, **CSV 다운로드**를 지원합니다.
  가로 막대 차트는 값 라벨·툴팁·표·CSV, KPI 스파크라인은 표시 전용입니다.
- 라이트/다크 테마(시스템 설정 또는 상단 버튼), 모바일 폭 대응. 외부 라이브러리·CDN 의존성이 없습니다.

## 배포 (GitHub Pages)

Data 저장소는 비공개이므로, 배포 워크플로가 토큰으로 Data 저장소의 `output/` 을 체크아웃해 `data/` 로 복사한 뒤 Pages 에 올립니다.

1. **Settings → Pages → Build and deployment → Source: `GitHub Actions`**
2. **Settings → Secrets and variables → Actions → New repository secret**
   - 이름: `DATA_REPO_TOKEN`
   - 값: Data 저장소에 대한 *fine-grained personal access token* (Repository access: `liskay93/Data`, Permissions: `Contents: Read`)
   - 토큰 **만료일**(기본 30일)에 주의하세요. 만료되면 워크플로가 "토큰으로 Data 저장소에 접근할 수 없습니다" 오류로 실패하므로 재발급 후 Secret 을 갱신합니다.
3. **Actions → "Deploy dashboard to GitHub Pages" → Run workflow** (또는 기본 브랜치에 push)
   - 배포 후 주소: `https://liskay93.github.io/Test/`
   - `github-pages` 환경의 배포 브랜치 제한이 켜져 있으면(Settings → Environments) 현재 기본 브랜치를 허용 목록에 추가하세요.

워크플로는 다음 시점에 실행됩니다.

- 기본 브랜치에 push (README 만 바뀐 경우 제외)
- 수동 실행 (`workflow_dispatch`, Data 저장소 브랜치를 지정 가능)
- Data 저장소가 보내는 `repository_dispatch` (`data-updated`) — Data 저장소에 `TEST_REPO_TOKEN` 을 등록한 경우
- 평일 07:30 KST 정기 실행 — 단, **공개 저장소는 60일간 활동(커밋 등)이 없으면 schedule 트리거가 자동 비활성화**됩니다(Actions 탭에서 재활성화).
  안정적인 자동 갱신을 원하면 Data 저장소에 `TEST_REPO_TOKEN` 을 등록해 `repository_dispatch` 경로를 사용하는 것을 권장합니다.

## 로컬에서 확인

```bash
# Data 저장소를 옆에 클론했다고 가정
cp -r ../Data/output ./data          # data/ 는 .gitignore 대상
npx serve .                          # 또는 python3 -m http.server 8080
# http://localhost:3000  (file:// 로 직접 열면 fetch 가 막혀 동작하지 않습니다)
```

`?data=<base URL>` 파라미터로 다른 산출물 위치를 지정할 수도 있습니다 (예: `?data=http://localhost:9000/output/`).

## 파일

```
index.html            페이지 골격
assets/config.js      데이터 소스 URL 목록·저장소 링크
assets/data.js        manifest / dates / latest / series 로더 (캐시, 날짜 이진탐색)
assets/charts.js      의존성 없는 SVG 차트 (라인·수익률곡선·가로막대·스파크라인, 툴팁·표·CSV)
assets/app.js         필터·KPI·패널 정의·렌더링
assets/style.css      라이트/다크 토큰, 레이아웃
.github/workflows/deploy-pages.yml   Pages 배포 워크플로
```

## 데이터 계약 (Data 저장소 `output/`)

- `manifest.json` — 시리즈 카탈로그(`id`, `group`, `name`, `unit`, `decimals`, `tenor_years`, `rating`, `file` …), 그룹 목록, 원본 메타데이터
- `dates.json` — 거래일 배열, `series/<id>.json` — `{"id", "values": [...]}` (dates 와 인덱스 정렬, 결측 `null`)
- `latest.json` — 시리즈별 최신값·변화량·스파크라인, `quality_report.json` — 정제 내역

대시보드는 이 계약만 알고 있으며, 시리즈가 추가·삭제되어도 `manifest.json` 기준으로 그룹·탐색기에 자동 반영됩니다.
