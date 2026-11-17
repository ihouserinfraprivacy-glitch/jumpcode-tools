#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "config.h"
#include "tasks/gps_task.h"
#include "tasks/modem_task.h"
#include "tasks/mqtt_task.h"
#include "tasks/ota_task.h"
#include "tasks/sensores_task.h"
#include "modules/energia.h"

QueueHandle_t fila_posicoes;

void app_main(void)
{
    energia_iniciar();
    fila_posicoes = xQueueCreate(TAMANHO_FILA_POSICOES, sizeof(posicao_t));
    xTaskCreate(gps_task, "gps", 4096, NULL, 5, NULL);
    xTaskCreate(modem_task, "modem", 4096, NULL, 6, NULL);
    xTaskCreate(sensores_task, "sensores", 3072, NULL, 4, NULL);
    xTaskCreate(mqtt_task, "mqtt", 6144, NULL, 5, NULL);
    xTaskCreate(ota_task, "ota", 8192, NULL, 2, NULL);
}
