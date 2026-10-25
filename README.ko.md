# TimeTree MCP Server

[English](README.md) | [한국어](#한국어)

## 한국어

> ⚠️ **면책조항**: 이것은 **개인 사용 전용** **비공식** TimeTree MCP 서버입니다. TimeTree, Inc.와 제휴 관계가 없으며 언제든 작동이 중단될 수 있습니다. 자세한 내용은 [DISCLAIMER.md](DISCLAIMER.md)를 참조하십시오.

MCP 클라이언트(Claude Desktop, Claude Code, Codex, Antigravity, Cline, Cursor, Windsurf 등)에서 TimeTree 캘린더 데이터를 관리할 수 있도록 하는 비공식 MCP (Model Context Protocol) 서버입니다.

> **크레딧**: 이 프로젝트는 [@eoleedi](https://github.com/eoleedi)의 [TimeTree-Exporter](https://github.com/eoleedi/TimeTree-Exporter)에서 영감을 받았으며 API 분석 결과를 활용했습니다.

### 기능

- 📅 **캘린더 목록** - 모든 TimeTree 캘린더 가져오기
- 📆 **이벤트 조회** - 자동 페이지네이션으로 캘린더 이벤트 조회
- 🔁 **반복 일정** - `RRULE` / `EXDATE`를 반환하고, 날짜 범위를 지정하면 각 회차로 펼침
- ➕ **이벤트 생성** - 캘린더에 새 이벤트 추가
- ✏️ **이벤트 수정** - 기존 이벤트 수정
- 🗑️ **이벤트 삭제** - 캘린더에서 이벤트 제거
- 🔐 **안전한 인증** - 이메일/비밀번호 인증 (MCP 설정에만 저장)
- ⚡ **속도 제한** - Token Bucket 알고리즘으로 API 과부하 방지
- 🔄 **자동 페이지네이션** - 여러 페이지에 걸친 모든 이벤트 자동 조회
- 🛡️ **에러 처리** - 사용자 친화적 메시지와 포괄적인 에러 처리
- 📝 **구조화된 로깅** - 민감한 데이터 마스킹이 포함된 상세 로그

### 요구사항

- Node.js >= 18.0.0
- Git (설치용)
- TimeTree 계정
- MCP 호환 클라이언트 (Claude Desktop, Claude Code, Codex, Antigravity, Cline 등)

### 설치

#### 빠른 설치 (권장)

**한 줄 설치** - 자동으로 복제, 빌드, `npm link` 실행 후 클라이언트 설정 예시를 출력:

```bash
curl -fsSL https://raw.githubusercontent.com/ehs208/TimeTree-MCP/main/TimeTree-MCP-install.sh | bash
```

스크립트가 `npm link`로 `timetree-mcp`를 로컬 npm 환경에 연결한 뒤, 지원하는 MCP 클라이언트 설정 예시를 보여줍니다. 사용하는 클라이언트의 설정을 복사하고 TimeTree 인증 정보만 입력하면 됩니다.

#### 수동 설치

<details>
<summary>수동 설치 단계 보기</summary>

1. **복제 및 빌드:**

```bash
git clone https://github.com/ehs208/TimeTree-MCP.git
cd TimeTree-MCP
npm install
npm run build
```

2. **로컬 `npx` 사용을 위해 패키지 링크:**

```bash
npm link
```

3. **MCP 클라이언트 설정:**

아래 [설정](#설정) 섹션을 참조하여 사용하는 MCP 클라이언트에 맞게 설정하세요.

</details>

### 설정

**빠른 예시 (Claude Desktop - macOS):**

`~/Library/Application Support/Claude/claude_desktop_config.json` 파일 수정:

```json
{
  "mcpServers": {
    "timetree": {
      "command": "npx",
      "args": ["timetree-mcp"],
      "env": {
        "TIMETREE_EMAIL": "your-email@example.com",
        "TIMETREE_PASSWORD": "your-password"
      }
    }
  }
}
```

위의 `npm link`를 한 번 실행한 뒤 Claude Desktop을 재시작하세요 (Cmd+Q로 종료 후 재실행).

📖 **모든 MCP 클라이언트 설정 (Claude Desktop Windows, Claude Code CLI, Codex, Antigravity, VS Code 에디터 등):**
→ 자세한 설정 방법은 **[docs/MCP_CLIENTS.md](docs/MCP_CLIENTS.md)** 참조

### 업데이트

최신 버전으로 업데이트하려면:

```bash
cd /path/to/TimeTree-MCP  # 또는 설치 경로
git pull origin main
npm install
npm run build
```

그 다음 MCP 클라이언트를 재시작하세요.

📖 **자세한 업데이트 방법 및 문제 해결:**
→ **[docs/UPDATING.md](docs/UPDATING.md)** 참조

### 사용법

📖 **자세한 사용 예시와 워크플로우는 [COMMANDS.md](COMMANDS.md) 참조**

### MCP 도구

- **list_calendars** - 참여 중인 사용자와 함께 모든 캘린더 조회
- **get_events** - 자동 페이지네이션으로 캘린더 이벤트 조회. 반복 일정은 `RRULE`/`EXDATE`를 포함하고, `from`/`to`(기본 시간대 `Asia/Tokyo`) 또는 `end_before`로 그 기간의 각 회차를 펼칩니다
- **get_updated_events** - 특정 시간 이후 업데이트된 이벤트 조회 (효율적인 증분 동기화)
- **create_event** - 캘린더에 새 이벤트 생성
- **update_event** - 기존 이벤트 수정
- **delete_event** - 캘린더에서 이벤트 삭제

📖 파라미터와 사용 세부사항은 [COMMANDS.md](COMMANDS.md) 참조

### 개발

```bash
# 프로젝트 빌드
npm run build

# Watch 모드 (변경사항 자동 재빌드)
npm run dev
```

### 제한사항

- **비공식 API**: TimeTree가 내부 API를 변경하면 작동이 중단될 수 있습니다
- **속도 제한**: 초당 10개 요청 (429 에러 시 자동 재시도)
- **공식 지원 없음**: TimeTree는 이 도구를 공식적으로 지원하지 않습니다
- **CSRF 토큰 필요**: 쓰기 작업은 CSRF 토큰 필요 (TimeTree 웹페이지에서 자동 추출)

### 보안

- 인증 정보는 **오직** 로컬 MCP 설정에만 저장됩니다
- 세션 쿠키는 메모리에만 저장 (디스크에 저장되지 않음)
- 비밀번호와 세션 ID는 로그에서 자동으로 마스킹됩니다
- 모든 통신은 HTTPS를 사용합니다

### 문제 해결

#### "Missing required environment variables" 오류

MCP 설정에 `TIMETREE_EMAIL`과 `TIMETREE_PASSWORD`가 설정되어 있는지 확인하세요.

#### 인증 실패

- 이메일과 비밀번호가 올바른지 확인하세요
- TimeTree 웹 앱에 로그인할 수 있는지 확인하세요
- TimeTree가 인증 API를 변경했을 수 있습니다

#### 캘린더나 이벤트가 반환되지 않음

- TimeTree 계정에 캘린더/이벤트가 있는지 확인하세요
- 자세한 오류 메시지는 로그를 확인하세요
- API가 변경되었을 수 있습니다

### 기여

기여를 환영합니다! 다음 절차를 따라주세요:

1. 저장소 포크
2. 기능 브랜치 생성
3. 변경사항 작성
4. Pull Request 제출

### 라이선스

MIT License - 자세한 내용은 [LICENSE](LICENSE) 파일 참조

### 면책조항

중요한 법적 및 사용 정보는 [DISCLAIMER.md](DISCLAIMER.md) 참조

---

**TIMETREE, INC.와 제휴 관계가 없습니다**

이것은 독립적이고 커뮤니티가 유지관리하는 프로젝트입니다.
