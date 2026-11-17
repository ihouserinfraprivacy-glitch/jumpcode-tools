#include "esp_https_ota.h"
#include "freertos/FreeRTOS.h"

#include "ota_task.h"

static const char *URL_FIRMWARE = "https://ota.rotacerta.com.br/firmware/rastreador.bin";

void ota_task(void *parametro)
{
    for (;;) {
        esp_http_client_config_t http = { .url = URL_FIRMWARE };
        esp_https_ota_config_t ota = { .http_config = &http };
        esp_https_ota(&ota);
        vTaskDelay(pdMS_TO_TICKS(6 * 60 * 60 * 1000));
    }
}
