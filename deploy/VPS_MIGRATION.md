# LOCOXATL — VPS migration guide

Moving the storefront from Railway (ephemeral container + Cloudinary) to a VPS that keeps the
uploaded images on its own disk. The application code is already driver-aware: `UPLOAD_DRIVER=local`
writes to `UPLOAD_DIR`, and historical `https://res.cloudinary.com/...` URLs stored in MySQL keep
rendering exactly as they do today.

Target layout:

```
/var/lib/locoxatl/uploads/            <- persistent volume (outside the git checkout)
        catalog/
        members/
        groups/
        products/
/var/www/locoxatl/                    <- git checkout + .env
/var/backups/locoxatl/                <- uploads archives + MySQL dumps
```

---

## 1. Create the upload volume

```bash
sudo mkdir -p /var/lib/locoxatl/uploads/{catalog,members,groups,products}
sudo useradd --system --home /var/www/locoxatl --shell /usr/sbin/nologin locoxatl 2>/dev/null || true
sudo chown -R locoxatl:locoxatl /var/lib/locoxatl
sudo chmod 750 /var/lib/locoxatl /var/lib/locoxatl/uploads
sudo chmod 750 /var/lib/locoxatl/uploads/{catalog,members,groups,products}
```

The Node process must own the tree: it creates the UUID files and deletes the replaced ones.
Nginx only needs read access, and runs as `www-data`, which is in the same group when the
directory is `750` and group-owned by `locoxatl`:

```bash
sudo usermod -aG locoxatl www-data
sudo systemctl restart nginx
```

Verify the permissions with `sudo -u locoxatl test -w /var/lib/locoxatl/uploads/groups && echo writable`.

---

## 2. Deploy the application

```bash
sudo mkdir -p /var/www/locoxatl
sudo chown locoxatl:locoxatl /var/www/locoxatl
sudo -u locoxatl git clone https://github.com/danishshxx/LOCOXATL.git /var/www/locoxatl
cd /var/www/locoxatl
sudo -u locoxatl git checkout DEVELOPMENT
sudo -u locoxatl npm ci --omit=dev
```

---

## 3. Configure `.env`

```bash
sudo -u locoxatl cp .env.example .env
sudo -u locoxatl nano .env
```

The upload block:

```dotenv
UPLOAD_DRIVER=local
UPLOAD_DIR=/var/lib/locoxatl/uploads

# Optional legacy object storage. Leave empty on the VPS; existing Cloudinary URLs in the
# database keep rendering either way.
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

Everything else (`DB_*`, `ADMIN_*`, `WHATSAPP_BUSINESS_NUMBER`, `INSTAGRAM_URL`, `PORT=4173`)
is unchanged. `UPLOAD_DRIVER=local` is the important line: without it a production process still
defaults to `local`, but naming it makes the intent explicit and survives future default changes.

Railway (or any container host) that must keep Cloudinary needs the opposite value:

```dotenv
UPLOAD_DRIVER=cloudinary
```

---

## 4. Database

```bash
cd /var/www/locoxatl
sudo -u locoxatl env $(grep -E '^DB_' .env | xargs) npm run db:migrate
```

The migrator is additive and idempotent; running it twice is safe and it never rewrites an order
or an `order_items` row.

To import an existing dump:

```bash
gunzip -c /var/backups/locoxatl/mysql-<STAMP>.sql.gz | mysql -h 127.0.0.1 -u locoxatl -p locoxatl
```

---

## 5. Start the app (PM2 or systemd)

### PM2

```bash
sudo npm i -g pm2
cd /var/www/locoxatl
sudo -u locoxatl pm2 start server.js --name locoxatl --time
sudo -u locoxatl pm2 startup systemd -u locoxatl --hp /var/www/locoxatl
sudo -u locoxatl pm2 save
```

### systemd (alternative)

`/etc/systemd/system/locoxatl.service`:

```ini
[Unit]
Description=LOCOXATL storefront
After=network.target mysql.service

[Service]
Type=simple
User=locoxatl
Group=locoxatl
WorkingDirectory=/var/www/locoxatl
EnvironmentFile=/var/www/locoxatl/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/locoxatl/uploads

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now locoxatl
sudo systemctl status locoxatl
```

`ReadWritePaths` is what lets the hardened unit keep writing to the upload volume; without it
every upload fails with `EACCES`.

---

## 6. Nginx + SSL for `locoxatl.ddns.net`

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
sudo cp /var/www/locoxatl/deploy/nginx-locoxatl.conf /etc/nginx/sites-available/locoxatl
sudo ln -sf /etc/nginx/sites-available/locoxatl /etc/nginx/sites-enabled/locoxatl
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
```

Issue the certificate once, before the TLS server block is active (comment the `listen 443`
block or run certbot with `--nginx` which rewrites it):

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d locoxatl.ddns.net \
     --email admin@locoxatl.example --agree-tos --no-eff-email
sudo nginx -t && sudo systemctl reload nginx
```

Renewal is automatic (`certbot.timer`); confirm with `sudo certbot renew --dry-run`.

Nginx serves `/uploads/` straight from `/var/lib/locoxatl/uploads/` with `autoindex off`, so the
Node process is only hit for API and page requests.

---

## 7. Backups

```bash
sudo install -m 750 /var/www/locoxatl/deploy/backup-locoxatl.sh /usr/local/bin/locoxatl-backup
sudo mkdir -p /var/backups/locoxatl && sudo chmod 700 /var/backups/locoxatl
sudo /usr/local/bin/locoxatl-backup
```

Daily cron entry (`sudo crontab -e`):

```cron
15 3 * * * /usr/local/bin/locoxatl-backup >> /var/log/locoxatl-backup.log 2>&1
```

Each run writes `uploads-<STAMP>.tar.gz` and `mysql-<STAMP>.sql.gz`, verifies both archives, and
prunes anything older than 14 days. Copy them off the box (`rsync`, `rclone`, S3) — a backup on
the same disk is not a backup.

### Restore

```bash
sudo systemctl stop locoxatl
sudo tar -xzf /var/backups/locoxatl/uploads-<STAMP>.tar.gz -C /var/lib/locoxatl
gunzip -c /var/backups/locoxatl/mysql-<STAMP>.sql.gz | mysql -h 127.0.0.1 -u locoxatl -p locoxatl
sudo chown -R locoxatl:locoxatl /var/lib/locoxatl
sudo systemctl start locoxatl
```

---

## 8. Verify the cutover

```bash
# the app answers
curl -sS -o /dev/null -w '%{http_code}\n' https://locoxatl.ddns.net/

# an upload is written to the volume, not the checkout
curl -sS https://locoxatl.ddns.net/api/catalog | head -c 200

# after uploading one image from the admin dashboard:
ls -l /var/lib/locoxatl/uploads/groups/            # <uuid>.png appears here
curl -sSI https://locoxatl.ddns.net/uploads/groups/<uuid>.png   # 200 + nosniff
```

Browser checklist: open `shop.html` and `artist.html` (covers and portraits render), `studio.html`
(member artwork renders), add to cart, and complete a checkout — the order must reach
`waiting_for_payment` with every line in `order_items`.

Historical images are untouched: rows that still hold a `res.cloudinary.com` URL render from
Cloudinary, rows written after the cutover render from `/uploads/...`.

---

## 9. Rollback

Point `UPLOAD_DRIVER=cloudinary` (with valid keys) and restart. New uploads go back to Cloudinary;
the files already on the volume keep serving from `/uploads/`, so nothing breaks in either
direction.
