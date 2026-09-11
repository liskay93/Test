/* 대시보드 설정 — 데이터는 Data 저장소의 output/ 산출물에서만 읽어 온다. */
window.DASHBOARD_CONFIG = {
  // 순서대로 manifest.json 을 찾아보고 처음 성공하는 곳을 데이터 소스로 사용한다.
  //  1) ./data/  : GitHub Actions 배포 시 Data 저장소 output/ 이 복사되는 위치 (로컬 개발 시 직접 복사)
  //  2) raw.githubusercontent.com : Data 저장소가 공개(public)로 전환된 경우에만 동작
  // URL 파라미터 ?data=<base-url> 로 소스를 강제 지정할 수도 있다.
  dataSources: [
    './data/',
    'https://raw.githubusercontent.com/liskay93/Data/main/output/',
    'https://raw.githubusercontent.com/liskay93/Data/claude/quirky-hopper-rv9x20/output/'
  ],
  dataRepoUrl: 'https://github.com/liskay93/Data',
  dashboardRepoUrl: 'https://github.com/liskay93/Test'
};
