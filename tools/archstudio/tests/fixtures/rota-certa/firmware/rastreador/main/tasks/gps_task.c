#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#include "gps_task.h"
#include "../config.h"
#include "../drivers/uart_gps.h"
#include "../modules/protocolo.h"

extern QueueHandle_t fila_posicoes;

void gps_task(void *parametro)
{
    uart_gps_iniciar();
    for (;;) {
        posicao_t posicao;
        if (uart_gps_ler(&posicao) == 0) {
            xQueueSend(fila_posicoes, &posicao, 0);
        }
        vTaskDelay(pdMS_TO_TICKS(INTERVALO_POSICAO_MS));
    }
}
