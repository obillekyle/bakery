export function renderLoginForm(errorMessage?: string) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Bakery Console - Login</title>
        <link rel="stylesheet" href="/_dashboard/style.css" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script src="https://code.iconify.design/iconify-icon/3.0.0/iconify-icon.min.js"></script>
      </head>
      <body class="dashboard-login">
        <div class="login-container">
          <div class="login-card glass-effect">
            <div class="logo-area">
              <div class="logo-badge">
                <iconify-icon icon="material-symbols:bolt-outline"></iconify-icon>
              </div>
              <h1 class="title">Bakery</h1>
              <p class="subtitle">Console Login</p>
            </div>
            <form method="POST" action="/_dashboard/login">
              {errorMessage ? (
                <div class="error-box">
                  <iconify-icon icon="lucide:alert-circle"></iconify-icon>
                  <span>{errorMessage}</span>
                </div>
              ) : (
                ''
              )}
              <div class="form-group">
                <div class="label-row">
                  <label class="label" for="password">
                    Password
                  </label>
                </div>
                <input
                  class="input-field"
                  type="password"
                  id="password"
                  name="password"
                  autocomplete="current-password"
                  placeholder="Enter DASHPASS password"
                  required
                  autofocus
                />
              </div>
              <button type="submit" class="login-btn">
                <span>Sign In</span>
                <iconify-icon icon="lucide:arrow-right"></iconify-icon>
              </button>
            </form>
          </div>
        </div>
        <script src="/_dashboard/dashboard.js"></script>
      </body>
    </html>
  )
}
