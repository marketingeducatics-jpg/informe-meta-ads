# Informe Meta Ads con GitHub Actions

Un flujo programado (cron) de GitHub Actions lee la API de Meta, genera el informe y lo publica en GitHub Pages. No usa Claude ni ningún servidor propio.

- `.github/workflows/informe.yml`: el cron y la publicación.
- `scripts/generar.mjs`: lee Meta, cifra los datos con la clave del informe y arma la carpeta `site/`.
- `pagina/index.html`: la página. Pide la clave, descifra los datos en el navegador y muestra el informe.

Los datos se publican **cifrados**: sin la clave, el archivo `data.enc.json` no se puede leer. La página permite elegir fechas dentro de los últimos 21 días.

## Horario

GitHub usa hora UTC; el flujo ya está ajustado a Ecuador (UTC-5):

- lunes a viernes, cada hora de 08:05 a 18:05;
- lunes 14:40 y jueves 11:10, antes de cada reunión.

GitHub puede retrasar un cron entre 5 y 30 minutos. Para generarlo en el momento: pestaña **Actions → Informe Meta Ads → Run workflow**.

## Puesta en marcha

### 1. Token de Meta (solo lectura)

1. En developers.facebook.com crea una app con el caso de uso de API de marketing, dentro del portafolio del negocio.
2. En Configuración del negocio → Usuarios → **Usuarios del sistema**, crea uno y asígnale la cuenta publicitaria con **Ver rendimiento**.
3. **Generar token** para esa app, sin caducidad, solo con el permiso `ads_read`.

### 2. Repositorio

1. En github.com crea un repositorio nuevo. Con el plan gratuito, GitHub Pages solo funciona si el repositorio es **público**; el código no contiene datos ni claves.
2. Sube el contenido de esta carpeta (incluida `.github`).

### 3. Secretos

En el repositorio → Settings → Secrets and variables → Actions → **New repository secret**:

| Secreto | Valor |
|---|---|
| `META_ACCESS_TOKEN` | el token del paso 1 |
| `META_AD_ACCOUNT_ID` | el número de la cuenta publicitaria |
| `REPORT_PASSWORD` | la clave del informe, de 12 caracteres o más |

La clave protege un archivo que cualquiera puede descargar, así que conviene una frase larga (cuatro o cinco palabras) y no una palabra corta.

### 4. Pages

Settings → Pages → Build and deployment → Source: **GitHub Actions**.

### 5. Primera ejecución

Actions → Informe Meta Ads → **Run workflow**. Al terminar, la dirección del informe aparece en el resumen de la ejecución (`https://<usuario>.github.io/<repositorio>/`).

## Mantenimiento

- **Falla una ejecución:** GitHub avisa por correo y el informe publicado se queda con los últimos datos buenos. El motivo sale en el registro de la ejecución.
- **Token vencido:** genera otro y actualiza el secreto `META_ACCESS_TOKEN`.
- **Cambiar la clave:** actualiza `REPORT_PASSWORD` y ejecuta el flujo.
- **Versión de la API:** por defecto `v26.0`. Para cambiarla, crea la variable `META_API_VERSION` en Settings → Secrets and variables → Actions → Variables.
- **Cron detenido:** en repositorios públicos GitHub desactiva los flujos programados tras 60 días sin cambios en el repositorio. Se reactivan desde la pestaña Actions.
- **Hora exacta:** si hace falta puntualidad, un servicio como cron-job.org puede lanzar el flujo llamando a la API de GitHub (`workflow_dispatch`); requiere un token de GitHub con permiso de Actions.
- **Reglas y bandas de costo:** están en `pagina/index.html`, en `BAND` y en la función `opportunities`.
