#include <stdio.h> 
#include <stdlib.h> 
#include <pthread.h> 

volatile int counter = 0; // 共享变量 
int loops; 

// 定义互斥锁 
pthread_mutex_t lock; 

void *worker(void *arg) { 
    int i; 
    for (i = 0; i < loops; i++) { 
        // 在增加 counter 之前加锁 
        pthread_mutex_lock(&lock); 
        counter++; 
        pthread_mutex_unlock(&lock); 
    } 
    return NULL; 
} 

int main(int argc, char *argv[]) { 
    if (argc != 2) { 
        fprintf(stderr, "Usage: %s <number_of_loops>\n", argv[0]); 
        return EXIT_FAILURE; 
    } 

    loops = atoi(argv[1]); 
   
    // 初始化互斥锁 
    pthread_mutex_init(&lock, NULL); 

    pthread_t p1, p2; 
    printf("Initial value: %d\n", counter); 
   
    pthread_create(&p1, NULL, worker, NULL); 
    pthread_create(&p2, NULL, worker, NULL); 
   
    pthread_join(p1, NULL); 
    pthread_join(p2, NULL); 
   
    printf("Final value : %d\n", counter); 

    // 销毁互斥锁 
    pthread_mutex_destroy(&lock); 

    return 0; 
}
