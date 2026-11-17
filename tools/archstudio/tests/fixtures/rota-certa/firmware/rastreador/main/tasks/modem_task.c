#include "freertos/FreeRTOS.h"

#include "modem_task.h"
#include "../drivers/uart_modem.h"
#include "../modules/energia.h"

void modem_task(void *parametro)
{
    uart_modem_iniciar();
    for (;;) {
        if (!uart_modem_conectado()) {
            energia_acordar_modem();
            uart_modem_comando("AT+CGATT=1");
        }
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
