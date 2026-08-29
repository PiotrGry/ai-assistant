from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow


SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]

CLIENT_SECRET = Path.home() / ".config/pirx/google/client_secret.json"
TOKEN_FILE = Path.home() / ".config/pirx/google/token.json"


def main():
    flow = InstalledAppFlow.from_client_secrets_file(
        CLIENT_SECRET,
        SCOPES,
    )

    creds = flow.run_local_server(port=8765, open_browser=False)

    TOKEN_FILE.write_text(creds.to_json())

    print(f"Token saved: {TOKEN_FILE}")


if __name__ == "__main__":
    main()
